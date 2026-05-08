#!/usr/bin/env node

const bcrypt = require('bcryptjs');
const readline = require('readline');
const { user, sequelize } = require('./models'); // Adjust path as needed

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const args = process.argv.slice(2);

async function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function createUser() {
  let username, password, fullName, role, store_id;

  try {
    // ——— Interactive mode (no args) or fast mode (all args provided) ———
    if (args.length === 0) {
      console.log('Creating a new user (interactive mode)\n');

      username   = await ask('Enter username: ');
      password   = await ask('Enter password: ');
      fullName   = await ask('Enter full name: ');

      do {
        role = (await ask('Enter role (admin / cashier): ')).toLowerCase().trim();
        if (!['admin', 'cashier'].includes(role)) {
          console.log('Invalid role! Please type "admin" or "cashier"');
        }
      } while (!['admin', 'cashier'].includes(role));

      store_id_input = await ask('Enter store ID (number): ');
      store_id = parseInt(store_id_input);
      if (isNaN(store_id)) {
        console.log('Store ID must be a number. Using null.');
        store_id = null;
      }

    } else if (args.length >= 4) {
      // Fast mode: node create-user.js <username> <password> <fullName> <role> [store_id]
      [username, password, fullName, role, store_id_input] = args;
      role = role.toLowerCase().trim();

      if (!['admin', 'cashier'].includes(role)) {
        console.error('Error: Role must be "admin" or "cashier"');
        process.exit(1);
      }

      store_id = store_id_input ? parseInt(store_id_input) : null;
      if (store_id_input && isNaN(store_id)) {
        console.error('Error: store_id must be a number if provided');
        process.exit(1);
      }

      console.log('Creating user from command-line arguments...');
    } else {
      console.log('Usage:');
      console.log('  Interactive: node create-user.js');
      console.log('  Fast mode:   node create-user.js <username> <password> "<full name>" <admin|cashier> [store_id]');
      process.exit(1);
    }

    // Trim inputs
    username = username.trim();
    fullName = fullName.trim();

    // Validation
    if (!username || !password || !fullName) {
      console.error('Error: Username, password, and full name are required!');
      process.exit(1);
    }

    // Check if user already exists
    const existingUser = await user.findOne({ where: { username } });
    if (existingUser) {
      console.error(`Error: User "${username}" already exists!`);
      process.exit(1);
    }

    // Hash password
    console.log('Hashing password...');
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create user
    console.log('Creating user in database...');
    const newUser = await user.create({
      username,
      password_hash: passwordHash,
      full_name: fullName,
      role,
      is_active: true,
      store_id: store_id || null
    });

    console.log('\nUser created successfully!');
    console.log('════════════════════════════════');
    console.log(`ID        : ${newUser.id}`);
    console.log(`Username  : ${newUser.username}`);
    console.log(`Full Name : ${newUser.full_name}`);
    console.log(`Role      : ${newUser.role}`);
    console.log(`Store ID  : ${newUser.store_id || 'none'}`);
    console.log(`Active    : ${newUser.is_active}`);

    // Verify password works
    const isValid = await bcrypt.compare(password, passwordHash);
    console.log(`\nPassword verification: ${isValid ? 'PASS' : 'FAIL'}`);

  } catch (error) {
    console.error('\nError:', error.message);
    if (error.name === 'SequelizeValidationError') {
      error.errors.forEach(err => console.error(`  • ${err.path}: ${err.message}`));
    }
  } finally {
    rl.close();
    await sequelize.close();
  }
}

createUser()