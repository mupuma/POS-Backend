"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Widen ZRA-related fields to prevent DataTooLong errors leading to rollbacks
    await queryInterface.changeColumn("credit_notes", "receiptsig", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.changeColumn("credit_notes", "intrldata", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert to previous sizes (best-effort based on current model before this migration)
    await queryInterface.changeColumn("credit_notes", "receiptsig", {
      type: Sequelize.STRING(50),
      allowNull: true,
    });
    await queryInterface.changeColumn("credit_notes", "intrldata", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },
};