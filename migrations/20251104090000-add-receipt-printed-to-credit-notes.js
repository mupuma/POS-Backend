"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add receipt_printed column to credit_notes table
    await queryInterface.addColumn("credit_notes", "receipt_printed", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      // keep near qrcode_url if supported (MySQL)
      after: "qrcode_url",
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("credit_notes", "receipt_printed");
  },
};