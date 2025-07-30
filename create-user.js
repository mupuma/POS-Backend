#!/usr/bin/env node

const bcrypt = require('bcryptjs');
const { user } = require('./models'); // Adjust path to your models
const { sequelize } = require('./models'); // Adjust path to your models

// Get command line arguments
const args = process.argv.slice(2);

async function createUser() {
    try {
        // Parse command line arguments
        let username, password, fullName, role;

        if (args.length === 0) {
            // Interactive mode - you can modify these values
            username = 'admin';
            password = 'pass2';
            fullName = 'Sys Admin';
            role = 'admin';

            console.log('Using default values:');
            console.log(`Username: ${username}`);
            console.log(`Password: ${password}`);
            console.log(`Full Name: ${fullName}`);
            console.log(`Role: ${role}`);
        } else if (args.length === 4) {
            // Command line arguments: username password fullName role
            [username, password, fullName, role] = args;
        } else {
            console.log('Usage: node create-user.js [username] [password] [fullName] [role]');
            console.log('Example: node create-user.js john pass2 "John Doe" cashier');
            console.log('Or run without arguments to use default values');
            process.exit(1);
        }

        // Validate role
        if (!['admin', 'cashier'].includes(role)) {
            console.error('Error: Role must be either "admin" or "cashier"');
            process.exit(1);
        }

        // Check if user already exists
        const existingUser = await user.findOne({ where: { username } });
        if (existingUser) {
            console.error(`Error: User "${username}" already exists`);
            process.exit(1);
        }

        // Hash the password
        console.log('Hashing password...');
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Create the user
        console.log('Creating user...');
        const newUser = await user.create({
            username: username,
            password_hash: passwordHash,
            full_name: fullName,
            role: role,
            is_active: true
        });

        console.log('✅ User created successfully!');
        console.log('User Details:');
        console.log(`- ID: ${newUser.id}`);
        console.log(`- Username: ${newUser.username}`);
        console.log(`- Full Name: ${newUser.full_name}`);
        console.log(`- Role: ${newUser.role}`);
        console.log(`- Password Hash: ${passwordHash}`);
        console.log(`- Active: ${newUser.is_active}`);

        // Test the password
        console.log('\n🔍 Testing password verification...');
        const isValid = await bcrypt.compare(password, passwordHash);
        console.log(`Password verification: ${isValid ? '✅ PASS' : '❌ FAIL'}`);

    } catch (error) {
        console.error('❌ Error creating user:', error.message);
        if (error.name === 'SequelizeValidationError') {
            error.errors.forEach(err => {
                console.error(`- ${err.path}: ${err.message}`);
            });
        }
    } finally {
        // Close database connection
        await sequelize.close();
        process.exit(0);
    }
}


createUser()