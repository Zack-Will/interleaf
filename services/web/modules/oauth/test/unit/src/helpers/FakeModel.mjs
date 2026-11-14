// A small in-memory stand-in for the Mongoose models these tests use. It
// supports the query shapes the services issue: equality (matching an element
// of an array field), $gt, $set and $push with $each / $slice.

let nextId = 1

function newId() {
  const id = (nextId++).toString(16).padStart(24, '0')
  return { toString: () => id, equals: other => String(other) === id }
}

function sameValue(a, b) {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime()
  }
  return String(a) === String(b)
}

function matchesCondition(value, condition) {
  if (
    condition &&
    typeof condition === 'object' &&
    !(condition instanceof Date) &&
    '$gt' in condition
  ) {
    return value != null && new Date(value) > new Date(condition.$gt)
  }
  if (Array.isArray(value)) {
    return value.some(element => sameValue(element, condition))
  }
  if (value == null || condition == null) return value == condition
  return sameValue(value, condition)
}

function matches(doc, query) {
  return Object.entries(query).every(([key, condition]) =>
    matchesCondition(doc[key], condition)
  )
}

function applyUpdate(doc, update) {
  Object.assign(doc, update.$set || {})
  for (const [key, push] of Object.entries(update.$push || {})) {
    const values = [...(doc[key] || []), ...push.$each]
    doc[key] = push.$slice == null ? values : values.slice(push.$slice)
  }
}

function copy(doc) {
  return doc ? { ...doc } : null
}

export default class FakeModel {
  constructor() {
    this.docs = []
  }

  async create(doc) {
    const stored = { _id: newId(), ...doc }
    this.docs.push(stored)
    return copy(stored)
  }

  async findOne(query) {
    return copy(this.docs.find(doc => matches(doc, query)))
  }

  find(query) {
    const results = this.docs.filter(doc => matches(doc, query)).map(copy)
    const chain = {
      sort: () => chain,
      lean: () => chain,
      exec: async () => results,
      then: (resolve, reject) => Promise.resolve(results).then(resolve, reject),
    }
    return chain
  }

  async findOneAndUpdate(query, update) {
    const doc = this.docs.find(candidate => matches(candidate, query))
    if (!doc) return null
    applyUpdate(doc, update)
    return copy(doc)
  }

  async findOneAndDelete(query) {
    const index = this.docs.findIndex(doc => matches(doc, query))
    if (index === -1) return null
    return this.docs.splice(index, 1)[0]
  }

  async updateOne(query, update) {
    const doc = this.docs.find(candidate => matches(candidate, query))
    if (doc) applyUpdate(doc, update)
    return { matchedCount: doc ? 1 : 0 }
  }

  async deleteOne(query) {
    const index = this.docs.findIndex(doc => matches(doc, query))
    if (index === -1) return { deletedCount: 0 }
    this.docs.splice(index, 1)
    return { deletedCount: 1 }
  }

  async deleteMany(query) {
    const before = this.docs.length
    this.docs = this.docs.filter(doc => !matches(doc, query))
    return { deletedCount: before - this.docs.length }
  }
}
