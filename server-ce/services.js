module.exports = [
  {
    name: 'web',
  },
  {
    name: 'real-time',
  },
  {
    name: 'document-updater',
  },
  {
    name: 'clsi',
  },
  {
    name: 'filestore',
  },
  {
    name: 'docstore',
  },
  {
    name: 'chat',
  },
  {
    name: 'notifications',
  },
  {
    name: 'project-history',
  },
  {
    name: 'history-v1',
  },
  {
    name: 'live-preview',
  },
]

if (require.main === module) {
  for (const service of module.exports) {
    console.log(service.name)
  }
}
