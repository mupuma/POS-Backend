"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("stores", "receipt_number", {
      type: Sequelize.STRING(50),
      allowNull: false,
      defaultValue: "RCP1001-1",
      after: "credit_note_number",
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("stores", "receipt_number");
  },
};