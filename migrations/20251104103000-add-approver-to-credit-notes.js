"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add approver_user_id column to credit_notes table
    await queryInterface.addColumn("credit_notes", "approver_user_id", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: "users",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
      after: "user_id",
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn("credit_notes", "approver_user_id");
  },
};