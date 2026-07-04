'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of ['sales', 'credit_notes']) {
      await queryInterface.changeColumn(table, 'next_retry_at', {
        type: Sequelize.DATE(3),
        allowNull: true,
      });
      await queryInterface.changeColumn(table, 'last_retry_at', {
        type: Sequelize.DATE(3),
        allowNull: true,
      });
      await queryInterface.sequelize.query(`
        UPDATE ${table}
        SET next_retry_at = CURRENT_TIMESTAMP(3)
        WHERE zra_status IN ('pending', 'failed')
          AND next_retry_at IS NULL
      `);
    }
  },

  async down(queryInterface, Sequelize) {
    for (const table of ['sales', 'credit_notes']) {
      await queryInterface.changeColumn(table, 'next_retry_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
      await queryInterface.changeColumn(table, 'last_retry_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },
};
