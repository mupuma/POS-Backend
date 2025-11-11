"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("sales", "zra_status", {
      type: Sequelize.ENUM("pending", "sent", "failed"),
      allowNull: false,
      defaultValue: "pending",
      comment: "Status of ZRA submission for this sale"
    });

    await queryInterface.addColumn("sales", "zra_error", {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: "Last error message from ZRA submission attempt"
    });

    await queryInterface.addColumn("sales", "retry_count", {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: "Number of retry attempts made to submit to ZRA"
    });

    await queryInterface.addColumn("sales", "next_retry_at", {
      type: Sequelize.DATE,
      allowNull: true,
      comment: "When to attempt the next retry for ZRA submission"
    });

    await queryInterface.addColumn("sales", "last_retry_at", {
      type: Sequelize.DATE,
      allowNull: true,
      comment: "When the last retry attempt occurred"
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("sales", "last_retry_at");
    await queryInterface.removeColumn("sales", "next_retry_at");
    await queryInterface.removeColumn("sales", "retry_count");
    await queryInterface.removeColumn("sales", "zra_error");
    await queryInterface.removeColumn("sales", "zra_status");

    // Remove ENUM type if created (MySQL ignores, Postgres needs explicit drop). Guard with try/catch.
    try {
      await queryInterface.sequelize.query("DROP TYPE IF EXISTS \"enum_sales_zra_status\";");
    } catch (_) { /* noop */ }
  }
};