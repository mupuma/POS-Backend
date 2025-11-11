const { Op, fn, col, where } = require('sequelize');

class Sage300InventoryService {
  constructor(mssqlDb) {
    // Pass in the mssqlDb instance
    if (!mssqlDb) {
      throw new Error('mssqlDb instance is required');
    }
    this.mssqlDb = mssqlDb;
  }

  /**
   * Fetch inventory details for all items starting with a prefix
   * @param {string} itemPrefix - Item prefix filter (e.g., "CP")
   * @returns {Promise<Array>} Array of inventory location details
   */
  async getInventoryByPrefix(itemPrefix) {
    try {
      // Access the model through the mssqlDb instance
      const items = await this.mssqlDb.ICILOC.findAll({
        where: {
          ITEMNO: {
            [Op.like]: `${itemPrefix}%`
          }
        },
        raw: true
      });

      // Map database fields to API-like format for backward compatibility
      return items.map(item => ({
        ItemNumber: item.ITEMNO.trim(),
        Location: item.LOCATION.trim(),
        QuantityOnHand: parseFloat(item.QTYONHAND) || 0,
        QuantityOnOrder: parseFloat(item.QTYONORDER) || 0,
        QuantityCommitted: parseFloat(item.QTYCOMMIT) || 0,
        QuantityAvailableToShip: parseFloat(item.QTYONHAND) - parseFloat(item.QTYCOMMIT) || 0,
        AverageCost: parseFloat(item.TOTALCOST) / parseFloat(item.QTYONHAND) || 0,
        TotalCost: parseFloat(item.TOTALCOST) || 0,
        LastReceiptDate: this.convertSageDate(item.LASTRCPTDT),
        MostRecentCost: parseFloat(item.RECENTCOST) || 0,
        LastShipDate: this.convertSageDate(item.LASTSHIPDT),
        StandardCost: parseFloat(item.STDCOST) || 0,
        LastStandardCost: parseFloat(item.LASTSTDCST) || 0,
        IsActive: item.ACTIVE === 1,
        // Additional fields available from ICILOC
        PickingSequence: item.PICKINGSEQ.trim(),
        LeadTime: item.LEADTIME,
        MinQuantityRequired: parseFloat(item.QTYMINREQ) || 0
      }));
    } catch (error) {
      console.error('Error fetching inventory from Sage 300 DB:', error.message);
      throw error;
    }
  }

  /**
   * Convert Sage 300 date format (YYYYMMDD as decimal) to ISO date string
   * @param {number} sageDate - Date in Sage format (e.g., 20240115)
   * @returns {string|null} ISO date string or null
   */
  convertSageDate(sageDate) {
    if (!sageDate || sageDate === 0) return null;

    const dateStr = sageDate.toString();
    if (dateStr.length !== 8) return null;

    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);

    return `${year}-${month}-${day}`;
  }

  /**
   * Get quantity on hand for a specific item and location
   * @param {string} itemNumber - Item number
   * @param {string} location - Location code
   * @returns {Promise<number|null>} Quantity on hand or null if not found
   */
  async getQuantityOnHand(itemNumber, location) {
    try {
      const item = await this.mssqlDb.ICILOC.findOne({
        where: {
          ITEMNO: itemNumber.padEnd(24, ' '),
          LOCATION: location.padEnd(6, ' ')
        },
        raw: true
      });

      return item ? parseFloat(item.QTYONHAND) : null;
    } catch (error) {
      console.error(`Error fetching quantity for ${itemNumber} at ${location}:`, error.message);
      return null;
    }
  }

  /**
   * Get all inventory for a specific item across all locations
   * @param {string} itemNumber - Item number
   * @returns {Promise<Array>} Array of location details
   */
  async getItemInventory(itemNumber) {
    try {
      const items = await this.mssqlDb.ICILOC.findAll({
        where: {
          ITEMNO: itemNumber.padEnd(24, ' ')
        },
        raw: true
      });

      return items.map(item => ({
        Location: item.LOCATION.trim(),
        QuantityOnHand: parseFloat(item.QTYONHAND) || 0,
        QuantityCommitted: parseFloat(item.QTYCOMMIT) || 0,
        QuantityAvailable: parseFloat(item.QTYONHAND) - parseFloat(item.QTYCOMMIT) || 0,
        TotalCost: parseFloat(item.TOTALCOST) || 0,
        RecentCost: parseFloat(item.RECENTCOST) || 0
      }));
    } catch (error) {
      console.error(`Error fetching inventory for ${itemNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Group inventory by item number with locations
   * @param {Array} inventoryData - Raw inventory data
   * @returns {Object} Grouped inventory by item number
   */
  groupInventoryByItem(inventoryData) {
    const grouped = {};

    inventoryData.forEach(item => {
      if (!grouped[item.ItemNumber]) {
        grouped[item.ItemNumber] = {
          itemNumber: item.ItemNumber,
          locations: []
        };
      }

      grouped[item.ItemNumber].locations.push({
        location: item.Location,
        quantityOnHand: item.QuantityOnHand,
        quantityCommitted: item.QuantityCommitted,
        quantityAvailableToShip: item.QuantityAvailableToShip,
        averageCost: item.AverageCost,
        totalCost: item.TotalCost,
        lastReceiptDate: item.LastReceiptDate,
        mostRecentCost: item.MostRecentCost,
        standardCost: item.StandardCost,
        isActive: item.IsActive,
        leadTime: item.LeadTime
      });
    });

    return grouped;
  }

  /**
   * Update product inventory in database for all stores
   * @param {Object} models - Sequelize models (PostgreSQL)
   * @param {string} itemPrefix - Item prefix to filter (e.g., "CP")
   * @param {Object} locationStoreMap - Map of Sage location codes to store IDs
   * @returns {Promise<Object>} Update results
   */
  async syncInventoryToDatabase(models, itemPrefix = 'CP', locationStoreMap = {}) {
    const results = {
      success: [],
      errors: [],
      updated: 0,
      created: 0,
      skipped: 0
    };

    try {
      // Fetch inventory from Sage 300 database
      const inventoryData = await this.getInventoryByPrefix(itemPrefix);
      console.log(`Found ${inventoryData.length} inventory records for items starting with ${itemPrefix}`);

      // Group by item number
      const groupedInventory = this.groupInventoryByItem(inventoryData);

      // Process each item
      for (const [itemNumber, itemData] of Object.entries(groupedInventory)) {
        try {
          // Find product by product_code (trim trailing spaces before comparing)
          const product = await models.product.findOne({
            where: where(fn('RTRIM', col('product_code')), itemNumber.trim())
          });

          if (!product) {
            results.skipped++;
            results.errors.push({
              itemNumber,
              error: 'Product not found in database'
            });
            continue;
          }

          // Update inventory for each location
          for (const location of itemData.locations) {
            const storeId = locationStoreMap[location.location];

            if (!storeId) {
              results.errors.push({
                itemNumber,
                location: location.location,
                error: 'Store mapping not found'
              });
              continue;
            }

            // Upsert product inventory
            const [inventory, created] = await models.productinventory.findOrCreate({
              where: {
                product_id: product.id,
                store_id: storeId
              },
              defaults: {
                stock_quantity: location.quantityOnHand || 0,
                min_stock_level: 0,
                is_active: true
              }
            });

            if (!created) {
              // Update existing record
              await inventory.update({
                stock_quantity: location.quantityOnHand || 0,
                updated_at: new Date()
              });
              results.updated++;
            } else {
              results.created++;
            }

            results.success.push({
              itemNumber,
              location: location.location,
              storeId,
              quantity: location.quantityOnHand,
              action: created ? 'created' : 'updated'
            });
          }

          // Update product cost based on first location's average cost
          const firstLocation = itemData.locations[0];
          await product.update({
            cost: firstLocation?.averageCost || product.cost,
            updated_at: new Date()
          });

        } catch (itemError) {
          results.errors.push({
            itemNumber,
            error: itemError.message
          });
        }
      }

      console.log(`Sync completed: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped, ${results.errors.length} errors`);

      return results;

    } catch (error) {
      console.error('Error syncing inventory:', error);
      throw error;
    }
  }

  /**
   * Get location to store mapping from database
   * @param {Object} models - Sequelize models (PostgreSQL)
   * @returns {Promise<Object>} Map of location codes to store IDs
   */
  async getLocationStoreMapping(models) {
    const stores = await models.store.findAll({
      attributes: ['id', 'store_number']
    });

    const mapping = {};
    stores.forEach(store => {
      if (store.store_number) {
        mapping[store.store_number] = store.id;
      }
    });

    return mapping;
  }

  /**
   * Convenience method to sync inventory with automatic store mapping
   * @param {Object} models - Sequelize models (PostgreSQL)
   * @param {string} itemPrefix - Item prefix to filter
   * @returns {Promise<Object>} Update results
   */
  async syncInventoryAuto(models, itemPrefix = 'CP') {
    const locationStoreMap = await this.getLocationStoreMapping(models);
    return this.syncInventoryToDatabase(models, itemPrefix, locationStoreMap);
  }

  /**
   * Get inventory summary statistics
   * @param {string} itemPrefix - Item prefix filter
   * @returns {Promise<Object>} Summary statistics
   */
  async getInventorySummary(itemPrefix = 'CP') {
    try {
      const items = await this.mssqlDb.ICILOC.findAll({
        where: {
          ITEMNO: {
            [Op.like]: `${itemPrefix}%`
          }
        },
        raw: true
      });

      const totalItems = new Set(items.map(i => i.ITEMNO.trim())).size;
      const totalLocations = items.length;
      const totalQuantity = items.reduce((sum, i) => sum + parseFloat(i.QTYONHAND), 0);
      const totalValue = items.reduce((sum, i) => sum + parseFloat(i.TOTALCOST), 0);

      return {
        totalItems,
        totalLocations,
        totalQuantity,
        totalValue,
        averageQuantityPerLocation: totalLocations > 0 ? totalQuantity / totalLocations : 0
      };
    } catch (error) {
      console.error('Error getting inventory summary:', error.message);
      throw error;
    }
  }
}

module.exports = Sage300InventoryService;