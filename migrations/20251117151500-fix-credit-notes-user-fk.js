"use strict";

/**
 * Fix incorrect foreign key on credit_notes.id -> users.id
 * and ensure the correct foreign key exists on credit_notes.user_id -> users.id
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = queryInterface;
    const sequelize = qi.sequelize;

    // Detect dialect
    const dialect = sequelize.getDialect();

    // Helper: try to drop a FK by exact name (ignore error if not exists)
    async function tryDropFKByName(table, constraintName) {
      try {
        await qi.removeConstraint(table, constraintName);
      } catch (e) {
        // Ignore if constraint doesn't exist in this environment
        if (!/unknown constraint|does not exist|can\'t DROP|check that column\/key exists/i.test(String(e && e.message))) {
          // For MySQL, error is ER_CANT_DROP_FIELD_OR_KEY: Can't DROP 'xxx'; check that column/key exists
          // For Postgres, it says does not exist
          // Log to console but do not fail migration
          // eslint-disable-next-line no-console
          console.warn(`Warning: could not drop constraint ${constraintName} on ${table}:`, e.message);
        }
      }
    }

    // 1) Find and drop ANY FK on credit_notes.id that references users.id (MySQL + Postgres)
    if (dialect === "mysql" || dialect === "mariadb") {
      const [rows] = await sequelize.query(
        "SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_notes' " +
          "AND COLUMN_NAME = 'id' AND REFERENCED_TABLE_NAME = 'users' AND REFERENCED_COLUMN_NAME = 'id'"
      );
      for (const r of rows) {
        await tryDropFKByName("credit_notes", r.CONSTRAINT_NAME);
      }
      // As a safety net, attempt to drop the name seen in the error message
      await tryDropFKByName("credit_notes", "credit_notes_ibfk_3");
    } else if (dialect === "postgres") {
      // Postgres: search pg catalogs for a FK on (id) referencing users(id)
      const [rows] = await sequelize.query(
        `SELECT con.conname AS constraint_name
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE con.contype = 'f'
           AND rel.relname = 'credit_notes'
           AND con.conkey[1] = (
               SELECT attnum FROM pg_attribute
               WHERE attrelid = rel.oid AND attname = 'id'
           )
           AND con.confrelid = (
               SELECT oid FROM pg_class WHERE relname = 'users'
           );`
      );
      for (const r of rows) {
        await tryDropFKByName("credit_notes", r.constraint_name);
      }
    }

    // 2) Ensure a proper FK exists on credit_notes.user_id -> users.id with CASCADE rules
    let userIdFkExists = false;
    if (dialect === "mysql" || dialect === "mariadb") {
      const [rows] = await sequelize.query(
        "SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_notes' " +
          "AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME = 'users' AND REFERENCED_COLUMN_NAME = 'id'"
      );
      userIdFkExists = rows && rows.length > 0;
    } else if (dialect === "postgres") {
      const [rows] = await sequelize.query(
        `SELECT con.conname AS constraint_name
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE con.contype = 'f'
           AND rel.relname = 'credit_notes'
           AND con.conkey[1] = (
               SELECT attnum FROM pg_attribute
               WHERE attrelid = rel.oid AND attname = 'user_id'
           )
           AND con.confrelid = (
               SELECT oid FROM pg_class WHERE relname = 'users'
           );`
      );
      userIdFkExists = rows && rows.length > 0;
    }

    if (!userIdFkExists) {
      await qi.addConstraint("credit_notes", {
        fields: ["user_id"],
        type: "foreign key",
        name: "fk_credit_notes_user_id_users_id",
        references: {
          table: "users",
          field: "id",
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    const qi = queryInterface;
    // Remove the correct FK if we added it
    await qi.removeConstraint("credit_notes", "fk_credit_notes_user_id_users_id").catch(() => {});

    // We will not attempt to recreate the incorrect FK on credit_notes.id, as it breaks inserts.
  },
};
