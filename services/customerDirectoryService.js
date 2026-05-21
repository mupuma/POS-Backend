const axios = require('axios');

class CustomerDirectoryService {
  constructor(models) {
    this.models = models;
    this.customerModel = models.customer;
    this.syncServerUrl = String(process.env.SYNC_SERVER_URL || '').replace(/\/$/, '');
    this.syncServerToken = process.env.SYNC_SERVER_TOKEN || '';
    this.zraBaseUrl = String(process.env.ZRA_BASE_URL || 'http://localhost:8082/sandboxvsdc').replace(/\/$/, '');
    this.zraLookupPath = String(process.env.ZRA_CUSTOMER_LOOKUP_PATH || 'https://portal.zra.org.zm/retrieveTaxpayersSearch').trim();
    this.zraLookupMethod = String(process.env.ZRA_CUSTOMER_LOOKUP_METHOD || 'POST').toUpperCase();
  }

  normalizeTpin(rawValue) {
    return String(rawValue || '').replace(/\D/g, '').trim();
  }

  buildZraLookupForm(tpin) {
    return new URLSearchParams({
      nrc: '',
      brn: '',
      tpin: this.normalizeTpin(tpin),
      taxpayername: '',
    });
  }

  buildZraLookupUrl() {
    if (!this.zraLookupPath) {
      return '';
    }

    if (/^https?:\/\//i.test(this.zraLookupPath)) {
      return this.zraLookupPath;
    }

    return `${this.zraBaseUrl}${this.zraLookupPath.startsWith('/') ? '' : '/'}${this.zraLookupPath}`;
  }

  sanitizeCustomer(customerRecord) {
    if (!customerRecord) {
      return null;
    }

    const plain = customerRecord.toJSON ? customerRecord.toJSON() : customerRecord;
    return {
      id: plain.id,
      name: plain.name || plain.legal_name || null,
      legalName: plain.legal_name || plain.name || null,
      tpin: plain.tpin || null,
      phone: plain.phone || null,
      email: plain.email || null,
      address: plain.address || null,
      lookupStatus: plain.lookup_status || 'resolved',
      lookupSource: plain.lookup_source || null,
      lookupError: plain.lookup_error || null,
      centralCustomerId: plain.central_customer_id || null,
      lastVerifiedAt: plain.last_verified_at || null,
      lastSyncedAt: plain.last_synced_at || null,
      needsCentralSync: Boolean(plain.needs_central_sync),
      zraLookupRequestedAt: plain.zra_lookup_requested_at || null,
      zraLookupCompletedAt: plain.zra_lookup_completed_at || null,
      createdAt: plain.created_at || null,
    };
  }

  async findLocalByTpin(tpin) {
    const normalizedTpin = this.normalizeTpin(tpin);
    if (!normalizedTpin) {
      return null;
    }

    return this.customerModel.findOne({ where: { tpin: normalizedTpin } });
  }

  async upsertLocalCustomer(input, overrides = {}) {
    const normalizedTpin = this.normalizeTpin(input.tpin);
    if (!normalizedTpin) {
      throw new Error('A valid TPIN is required');
    }

    const defaults = {
      tpin: normalizedTpin,
      name: input.name || input.legalName || null,
      legal_name: input.legalName || input.name || null,
      phone: input.phone || null,
      email: input.email || null,
      address: input.address || null,
      lookup_status: overrides.lookup_status || input.lookupStatus || 'resolved',
      lookup_source: overrides.lookup_source || input.lookupSource || 'local',
      lookup_error: overrides.lookup_error || null,
      central_customer_id: overrides.central_customer_id || input.centralCustomerId || null,
      last_verified_at: overrides.last_verified_at || input.lastVerifiedAt || null,
      last_synced_at: overrides.last_synced_at || input.lastSyncedAt || null,
      zra_lookup_requested_at: overrides.zra_lookup_requested_at || null,
      zra_lookup_completed_at: overrides.zra_lookup_completed_at || null,
      needs_central_sync: overrides.needs_central_sync === undefined
        ? Boolean(input.needsCentralSync)
        : Boolean(overrides.needs_central_sync),
    };

    const [customerRecord, created] = await this.customerModel.findOrCreate({
      where: { tpin: normalizedTpin },
      defaults,
    });

    if (!created) {
      await customerRecord.update({
        name: defaults.name,
        legal_name: defaults.legal_name,
        phone: defaults.phone,
        email: defaults.email,
        address: defaults.address,
        lookup_status: defaults.lookup_status,
        lookup_source: defaults.lookup_source,
        lookup_error: defaults.lookup_error,
        central_customer_id: defaults.central_customer_id,
        last_verified_at: defaults.last_verified_at,
        last_synced_at: defaults.last_synced_at,
        zra_lookup_requested_at: defaults.zra_lookup_requested_at || customerRecord.zra_lookup_requested_at,
        zra_lookup_completed_at: defaults.zra_lookup_completed_at,
        needs_central_sync: defaults.needs_central_sync,
      });
    }

    return created ? customerRecord : this.findLocalByTpin(normalizedTpin);
  }

  async createOrRefreshPendingCustomer(tpin) {
    const normalizedTpin = this.normalizeTpin(tpin);
    if (!normalizedTpin) {
      throw new Error('A valid TPIN is required');
    }

    const existingCustomer = await this.findLocalByTpin(normalizedTpin);
    if (existingCustomer) {
      await existingCustomer.update({
        lookup_status: 'pending',
        lookup_source: null,
        lookup_error: null,
        zra_lookup_requested_at: new Date(),
      });
      return this.findLocalByTpin(normalizedTpin);
    }

    return this.upsertLocalCustomer({ tpin: normalizedTpin }, {
      lookup_status: 'pending',
      lookup_source: null,
      lookup_error: null,
      zra_lookup_requested_at: new Date(),
      needs_central_sync: false,
    });
  }

  async lookupCentralByTpin(tpin) {
    const normalizedTpin = this.normalizeTpin(tpin);
    if (!normalizedTpin || !this.syncServerUrl) {
      return null;
    }

    try {
      const response = await axios.get(`${this.syncServerUrl}/api/customers/lookup`, {
        params: { tpin: normalizedTpin },
        headers: this.syncServerToken ? { Authorization: `Bearer ${this.syncServerToken}` } : {},
        timeout: 10000,
      });

      return response.data?.customer || null;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }

      console.warn(
        'Central customer lookup unavailable, falling back to ZRA:',
        error.response?.data?.message || error.message,
      );
      return null;
    }
  }

  extractZraCustomer(data, fallbackTpin) {
    const responseStatus = String(data?.status || '').trim().toUpperCase();
    const messageRows = Array.isArray(data?.message) ? data.message : [];

    if (responseStatus && responseStatus !== 'FOUND' && messageRows.length === 0) {
      return null;
    }

    if (messageRows.length > 0) {
      const match = messageRows.find((row) => row && (row.taxPayerName || row.taxpayerName || row.tpin)) || messageRows[0];
      const name = String(match?.taxPayerName || match?.taxpayerName || '').trim();
      const tpin = this.normalizeTpin(match?.tpin || fallbackTpin);

      if (!name || !tpin) {
        return null;
      }

      return {
        tpin,
        name,
        legalName: name,
        zraStatus: String(match?.status || '').trim() || null,
        isDeregistered: String(match?.isDeregistered || '').trim() || null,
        taxTypes: String(match?.taxTypes || '').trim() || null,
        effectiveDateOfReg: String(match?.effectiveDateOfReg || '').trim() || null,
      };
    }

    const candidates = [
      data,
      data?.data,
      data?.result,
      data?.taxpayer,
      data?.customer,
      data?.info,
      Array.isArray(data?.data) ? data.data[0] : null,
      Array.isArray(data?.result) ? data.result[0] : null,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const name = candidate.taxprNm
        || candidate.taxPayerName
        || candidate.taxpayerName
        || candidate.customerName
        || candidate.custNm
        || candidate.legalName
        || candidate.name
        || candidate.taxpayer?.name
        || null;

      if (!name) {
        continue;
      }

      const tpin = this.normalizeTpin(candidate.tpin || candidate.TPIN || fallbackTpin);
      return {
        tpin,
        name: String(name).trim(),
        legalName: String(name).trim(),
      };
    }

    return null;
  }

  async resolveWithZra(customerRecord) {
    const normalizedTpin = this.normalizeTpin(customerRecord?.tpin);
    if (!normalizedTpin) {
      throw new Error('A valid TPIN is required');
    }

    const requestUrl = this.buildZraLookupUrl();
    if (!requestUrl) {
      await customerRecord.update({
        lookup_status: 'failed',
        lookup_error: 'ZRA customer lookup is not configured',
        zra_lookup_completed_at: new Date(),
      });

      return { success: false, error: 'ZRA customer lookup is not configured' };
    }

    try {
      const payload = this.buildZraLookupForm(normalizedTpin);
      const requestConfig = {
        url: requestUrl,
        method: this.zraLookupMethod,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/plain, */*',
        },
        timeout: 20000,
      };

      if (this.zraLookupMethod === 'GET') {
        requestConfig.params = Object.fromEntries(payload.entries());
      } else {
        requestConfig.data = payload.toString();
      }

      const response = await axios(requestConfig);

      const customerData = this.extractZraCustomer(response.data, normalizedTpin);
      if (!customerData) {
        const lookupError = response.data?.resultMsg
          || (Array.isArray(response.data?.message)
            ? response.data.message[0]?.taxPayerName || response.data.message[0]?.taxpayerName || null
            : response.data?.message)
          || response.data?.status
          || 'Customer was not found in ZRA or the ZRA response format was unexpected';
        await customerRecord.update({
          lookup_status: 'failed',
          lookup_error: String(lookupError),
          zra_lookup_completed_at: new Date(),
        });

        return { success: false, error: String(lookupError) };
      }

      const resolvedCustomer = await this.upsertLocalCustomer(customerData, {
        lookup_status: 'resolved',
        lookup_source: 'zra',
        lookup_error: null,
        last_verified_at: new Date(),
        zra_lookup_completed_at: new Date(),
        needs_central_sync: true,
      });

      return { success: true, customer: resolvedCustomer };
    } catch (error) {
      const lookupError = error.response?.data?.resultMsg
        || (Array.isArray(error.response?.data?.message)
          ? error.response.data.message[0]?.taxPayerName || error.response.data.message[0]?.taxpayerName || JSON.stringify(error.response.data.message[0] || {})
          : error.response?.data?.message)
        || error.response?.data?.status
        || error.message;
      await customerRecord.update({
        lookup_status: 'failed',
        lookup_error: String(lookupError),
        zra_lookup_completed_at: new Date(),
      });

      return { success: false, error: String(lookupError) };
    }
  }

  async syncToCentral(customerRecord) {
    if (!customerRecord?.tpin || !this.syncServerUrl) {
      return { success: false, skipped: true };
    }

    try {
      const payload = {
        tpin: customerRecord.tpin,
        name: customerRecord.name || customerRecord.legal_name || null,
        legalName: customerRecord.legal_name || customerRecord.name || null,
        phone: customerRecord.phone || null,
        email: customerRecord.email || null,
        address: customerRecord.address || null,
        lookupSource: customerRecord.lookup_source || null,
        lastVerifiedAt: customerRecord.last_verified_at || null,
      };

      const response = await axios.put(
        `${this.syncServerUrl}/api/customers/by-tpin/${customerRecord.tpin}`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            ...(this.syncServerToken ? { Authorization: `Bearer ${this.syncServerToken}` } : {}),
          },
          timeout: 10000,
        }
      );

      await customerRecord.update({
        central_customer_id: String(response.data?.customer?.id || customerRecord.central_customer_id || ''),
        last_synced_at: new Date(),
        needs_central_sync: false,
      });

      return { success: true, customer: response.data?.customer || null };
    } catch (error) {
      await customerRecord.update({ needs_central_sync: true });
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  async lookupCustomerChain(tpin) {
    const normalizedTpin = this.normalizeTpin(tpin);
    if (!normalizedTpin) {
      throw new Error('A valid TPIN is required');
    }

    const localCustomer = await this.findLocalByTpin(normalizedTpin);
    if (localCustomer && localCustomer.lookup_status === 'resolved') {
      return {
        status: 'resolved',
        source: 'local',
        customer: localCustomer,
      };
    }

    const centralCustomer = await this.lookupCentralByTpin(normalizedTpin);
    if (centralCustomer) {
      const savedCustomer = await this.upsertLocalCustomer(centralCustomer, {
        lookup_status: 'resolved',
        lookup_source: 'central',
        lookup_error: null,
        last_verified_at: new Date(),
        last_synced_at: new Date(),
        central_customer_id: centralCustomer.id == null ? null : String(centralCustomer.id),
        needs_central_sync: false,
      });

      return {
        status: 'resolved',
        source: 'central',
        customer: savedCustomer,
      };
    }

    const pendingCustomer = await this.createOrRefreshPendingCustomer(normalizedTpin);
    return {
      status: 'pending',
      source: 'zra',
      customer: pendingCustomer,
    };
  }
}

module.exports = CustomerDirectoryService;