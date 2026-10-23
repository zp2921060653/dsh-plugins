// Static check of the tool definitions this bundle registers: the emitted JSON
// Schema must use only the keywords the model API accepts, with `required`
// hoisted to the object level and no `enum` anywhere.
//
// Run: node dev/schema-check.mjs
import { apply } from '../index.js'

const registered = []
const ctx = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  effect: (fn) => { const dispose = fn(); return () => dispose && dispose() },
  get: () => undefined,
}

apply(ctx, { headless: true })

const ALLOWED_PROP_KEYS = new Set(['type', 'description', 'items', 'properties', 'required', 'additionalProperties'])
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
const problems = []

function walk(node, path) {
  if (!node || typeof node !== 'object') {
    problems.push(`${path}: not an object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_PROP_KEYS.has(key)) problems.push(`${path}: unexpected keyword "${key}"`)
  }
  if (node.enum) problems.push(`${path}: enum is not allowed`)
  if (node.description != null && typeof node.description !== 'string') problems.push(`${path}.description: not a string`)
  if (node.type != null) {
    if (!ALLOWED_TYPES.has(node.type)) problems.push(`${path}.type: invalid "${node.type}"`)
  } else if (path !== '#' && !node.description) {
    problems.push(`${path}: neither type nor description`)
  }
  if (node.type === 'array') {
    if (!node.items) problems.push(`${path}: array without items`)
    else walk(node.items, path + '.items')
  }
  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.${key}`)
  }
  if (node.required != null) {
    if (!Array.isArray(node.required)) problems.push(`${path}.required: not an array`)
    else {
      for (const name of node.required) {
        if (!node.properties || !(name in node.properties)) problems.push(`${path}.required: unknown property "${name}"`)
      }
    }
  }
}

console.log('registered tools:', registered.map((t) => t.name).join(', '))
for (const tool of registered) {
  console.log(`\n=== ${tool.name} ===`)
  const schema = tool.parameters
  console.log('top-level keys:', Object.keys(schema).join(','))
  console.log('required:', JSON.stringify(schema.required))
  console.log('properties:', Object.keys(schema.properties || {}).length)
  console.log('sample:', JSON.stringify({ action: schema.properties.action, format: schema.properties.format, values: schema.properties.values }, null, 1).slice(0, 700))
  walk(schema, '#')
  // Every top-level property must be a JSON-Schema object.
  if (schema.type !== 'object') problems.push(`${tool.name}: parameters.type must be object`)
  if (!schema.properties || typeof schema.properties !== 'object') problems.push(`${tool.name}: parameters.properties missing`)
  for (const [key, value] of Object.entries(tool.parameters.properties || {})) {
    if (value == null || typeof value !== 'object') problems.push(`${tool.name}.${key}: property is not an object`)
  }
  if (tool.output && tool.output.schema) {
    const out = tool.output.schema
    if (out.type !== 'object') problems.push(`${tool.name}.output: root type must be object`)
    if (typeof tool.output.render !== 'function') problems.push(`${tool.name}.output: render missing`)
  }
}

console.log('\nproblems:', problems.length)
for (const p of problems) console.log(' -', p)
process.exit(problems.length ? 1 : 0)
