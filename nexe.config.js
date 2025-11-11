module.exports = {
  input: 'server.js',  // or 'server.js'
  output: 'pos-backend.exe',
  target: 'windows-x64-22.9.0',  // or 'windows-x64-22.9.0' with build: true
  build: true,  // Set true for Node 22
  resources: [
    './models/**/*.js',  // Sequelize models
    './migrations/**/*', // Sequelize migrations
    './config/**/*',     // DB configs
    './views/**/*.pug',  // Pug templates
    './public/**/*',     // Static assets
    './.env'             // If using dotenv
  ]
};