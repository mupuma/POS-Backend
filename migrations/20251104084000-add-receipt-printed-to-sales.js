"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add receipt_printed column to sales table
    await queryInterface.addColumn("sales", "receipt_printed", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      after: "qrcode_url", // try to keep near related fields (MySQL-specific, safe to ignore if not supported)
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("sales", "receipt_printed");
  },
};