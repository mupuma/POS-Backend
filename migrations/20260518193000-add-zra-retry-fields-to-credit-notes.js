'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('credit_notes', 'zra_status', {
      type: Sequelize.ENUM('pending', 'sent', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    });

    await queryInterface.addColumn('credit_notes', 'zra_error', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addColumn('credit_notes', 'retry_count', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.addColumn('credit_notes', 'next_retry_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('credit_notes', 'last_retry_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('credit_notes', 'last_retry_at');
    await queryInterface.removeColumn('credit_notes', 'next_retry_at');
    await queryInterface.removeColumn('credit_notes', 'retry_count');
    await queryInterface.removeColumn('credit_notes', 'zra_error');
    await queryInterface.removeColumn('credit_notes', 'zra_status');

    if (Sequelize?.getDialect?.() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_credit_notes_zra_status";');
    }
  },
};
