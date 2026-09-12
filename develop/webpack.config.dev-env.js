const { merge } = require('webpack-merge')

const base = require('./webpack.config.dev')

module.exports = merge(base, {
  devServer: {
    allowedHosts: 'auto',
    devMiddleware: {
      index: false,
    },
    proxy: [
      {
        context: '/socket.io/**',
        target: 'http://real-time:3026',
        ws: true,
      },
      {
        // git clone http://git@localhost/git/<projectId> — git-bridge's
        // Oauth2Filter expects the project id at the root, so drop the prefix.
        context: '/git/**',
        target: 'http://git-bridge:8000',
        pathRewrite: { '^/git': '' },
      },
      {
        context: ['!**/*.js', '!**/*.css', '!**/*.json'],
        target: 'http://web:3000',
      },
    ],
  },
})
