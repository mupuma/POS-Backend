"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Ensure 'mixed' is included in the ENUM for credit_notes.payment_method (MySQL variant)
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'mysql' || dialect === 'mariadb') {
      await queryInterface.sequelize.query(
        "ALTER TABLE `credit_notes` MODIFY `payment_method` ENUM('cash','card','mobile_money','mixed') NOT NULL;"
      );
    } else if (dialect === 'postgres') {
      // Postgres: create new type value if needed
      // Try adding value; if it exists, this will error, so wrap with catch via DO block
      await queryInterface.sequelize.query(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'enum_credit_notes_payment_method' AND e.enumlabel = 'mixed') THEN ALTER TYPE \"enum_credit_notes_payment_method\" ADD VALUE 'mixed'; END IF; END $$;"
      );
    }
  },

  async down(queryInterface, Sequelize) {
    // Down migration is intentionally a no-op to avoid data loss if rows with 'mixed' exist.
    // To revert manually, ensure no 'mixed' values exist, then recreate the enum.
  },
};