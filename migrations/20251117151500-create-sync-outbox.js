"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("sync_outbox", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      event_type: {
        type: Sequelize.STRING(100),
        allowNull: false
      },
      aggregate_type: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      aggregate_id: {
        type: Sequelize.INTEGER,
        allowNull: false
      },
      store_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: "stores",
          key: "id"
        },
        onUpdate: "CASCADE",
        onDelete: "CASCADE"
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: "users",
          key: "id"
        },
        onUpdate: "CASCADE",
        onDelete: "SET NULL"
      },
      receipt_number: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      idempotency_key: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: false
      },
      status: {
        type: Sequelize.ENUM("pending", "sending", "sent", "failed", "dead_letter"),
        allowNull: false,
        defaultValue: "pending"
      },
      attempt_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      next_retry_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      last_attempt_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      sent_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      last_error: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      response_payload: {
        type: Sequelize.JSON,
        allowNull: true
      },
      locked_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP")
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP")
      }
    });

    await queryInterface.addIndex("sync_outbox", ["status"], { name: "idx_sync_outbox_status" });
    await queryInterface.addIndex("sync_outbox", ["next_retry_at"], { name: "idx_sync_outbox_next_retry_at" });
    await queryInterface.addIndex("sync_outbox", ["store_id"], { name: "idx_sync_outbox_store_id" });
    await queryInterface.addIndex("sync_outbox", ["status", "next_retry_at"], { name: "idx_sync_outbox_status_next_retry" });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("sync_outbox");

    try {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_sync_outbox_status";');
    } catch (_) {}
  }
};