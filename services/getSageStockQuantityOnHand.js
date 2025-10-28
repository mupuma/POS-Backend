const axios = require('axios');

class Sage300InventoryService {
  constructor(baseUrl = process.env.SAGE_BASE_URL || 'http://localhost/Sage300WebApi/v1.0/-/INDCOM') {
      const username = process.env.SAGE_USERNAME || "ADMIN";
            const password = process.env.SAGE_PASSWORD || "Admin123!";

            // Encode auth as Base64
            const auth = `${username}:${password}`;
            const encodedAuth = Buffer.from(auth, "utf-8").toString("base64");
            const authorization = `Basic ${encodedAuth}`;

      this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
          'Authorization': authorization,
      }
    });
  }

  /**
   * Fetch inventory details for all items starting with a prefix
   * @param {string} itemPrefix - Item prefix filter (e.g., "CP")
   * @returns {Promise<Array>} Array of inventory location details
   */
  async getInventoryByPrefix(itemPrefix) {
    try {
      const response = await this.client.get("/IC/ICLocationDetails?$filter=startswith(ItemNumber,'CP')", {
        data: {}
      });

      if (!response.data || !response.data.value) {
        throw new Error('Invalid response format from Sage 300 API');
      }

      // Filter items that start with the specified prefix
      const filteredItems = response.data.value.filter(item =>
        item.ItemNumber && item.ItemNumber.startsWith(itemPrefix)
      );

      return filteredItems;
    } catch (error) {
      console.error('Error fetching inventory from Sage 300:', error.message);
      throw error;
    }
  }

  /**
   * Get quantity on hand for a specific item and location
   * @param {string} itemNumber - Item number
   * @param {string} location - Location code
   * @returns {Promise<number|null>} Quantity on hand or null if not found
   */
  async getQuantityOnHand(itemNumber, location) {
    try {
      const response = await this.client.get('/IC/ICLocationDetails', {
        data: {}
      });
        console.log(response)
      if (!response.data || !response.data.value) {
        return null;
      }

      const item = response.data.value.find(i =>
        i.ItemNumber === itemNumber && i.Location === location
      );

      return item ? item.QuantityOnHand : null;
    } catch (error) {
      console.error(`Error fetching quantity for ${itemNumber} at ${location}:`, error.message);
      return null;
    }
  }

  /**
   * Group inventory by item number with locations
   * @param {Array} inventoryData - Raw inventory data from API
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
        locationName: item.Name,
        quantityOnHand: item.QuantityOnHand,
        averageCost: item.AverageCost,
        totalCost: item.TotalCost,
        quantityAvailableToShip: item.QuantityAvailableToShip,
        quantityCommitted: item.QuantityCommitted,
        lastReceiptDate: item.LastReceiptDate,
        mostRecentCost: item.MostRecentCost
      });
    });

    return grouped;
  }

  /**
   * Update product inventory in database for all stores
   * @param {Object} models - Sequelize models
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
      // Fetch inventory from Sage 300
      const inventoryData = await this.getInventoryByPrefix(itemPrefix);
      console.log(`Found ${inventoryData.length} inventory records for items starting with ${itemPrefix}`);

      // Group by item number
      const groupedInventory = this.groupInventoryByItem(inventoryData);

      // Process each item
      for (const [itemNumber, itemData] of Object.entries(groupedInventory)) {
        try {
          // Find product by product_code
          const product = await models.product.findOne({
            where: { product_code: itemNumber }
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

          // Do not update product-level stock; stock is managed per store in productinventory
          // Optionally, update product cost based on first location's average cost
          await product.update({
            cost: itemData.locations[0]?.averageCost || product.cost,
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
   * @param {Object} models - Sequelize models
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
   * @param {Object} models - Sequelize models
   * @param {string} itemPrefix - Item prefix to filter
   * @returns {Promise<Object>} Update results
   */
  async syncInventoryAuto(models, itemPrefix = 'CP') {
    const locationStoreMap = await this.getLocationStoreMapping(models);
    return this.syncInventoryToDatabase(models, itemPrefix, locationStoreMap);
  }
}
module.exports = Sage300InventoryService;