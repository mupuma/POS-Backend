'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('credit_note_items');

    if (!table.category_id) {
      await queryInterface.addColumn('credit_note_items', 'category_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'categories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE credit_note_items AS creditNoteItem
      LEFT JOIN products AS product ON product.id = creditNoteItem.product_id
      SET creditNoteItem.category_id = product.category_id
      WHERE creditNoteItem.category_id IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('credit_note_items', 'category_id');
  },
};
