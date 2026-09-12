import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import ProjectRef from '../project-sync/app/src/ProjectRef.mjs'
import SnapshotService from '../project-sync/app/src/SnapshotService.mjs'
import VersionService from '../project-sync/app/src/VersionService.mjs'
import LabelService from '../project-sync/app/src/LabelService.mjs'
import WriteService from '../project-sync/app/src/WriteService.mjs'
import ProjectGetter from '../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectEntityHandler from '../../app/src/Features/Project/ProjectEntityHandler.mjs'
import { requireAccessToken } from '../project-sync/app/src/TokenAuthMiddleware.mjs'

const defaults = { ProjectRef, SnapshotService, VersionService, LabelService, WriteService, ProjectGetter, ProjectEntityHandler }
const textResult = (data, text = JSON.stringify(data)) => ({ content: [{ type: 'text', text }], structuredContent: data })
const errorResult = (e, next = 'check request') => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }], structuredContent: { code: e.code || 'error', message: e.message || String(e), ...(e.expectedVersion != null ? { expected_version: e.expectedVersion } : {}), ...(e.actualVersion != null ? { actual_version: e.actualVersion } : {}), next_action: next } })

function projectId(ref, services) { return services.ProjectRef.parse(ref).projectId }
async function access(services, req, id, level='read') { return services.ProjectRef.requireAccess(req.syncUser.userId, id, level) }

export function registerTools(server, { services = defaults, req = {}, clientName } = {}) {
  const svc = { ...defaults, ...services }
  const userId = req.syncUser?.userId
  const run = async (fn, next) => { try { return textResult(await fn()) } catch (e) { return errorResult(e, next) } }

  server.tool('list_projects', 'List projects', {}, async () => run(async () => {
    const all = await svc.ProjectGetter.promises.findAllUsersProjects(userId, 'name lastUpdated')
    const out = []
    for (const [key, arr] of Object.entries(all || {})) for (const p of arr || []) {
      const id = String(p._id || p.id || p.projectId); const write = key === 'owned' || key === 'readAndWrite' || key === 'tokenReadAndWrite'
      out.push({ project_id: id, url: svc.ProjectRef.urlFor(id), name: p.name, permissions: write ? 'write' : 'read' })
    }
    return out
  }))

  server.tool('get_project', 'Get project metadata', { project: z.string() }, async ({ project }) => run(async () => {
    const id = projectId(project, svc); await access(svc, req, id)
    const p = await svc.ProjectGetter.promises.getProject(id, { name: 1, rootDoc_id: 1 })
    const tree = await svc.SnapshotService.getFileTree(id); const version = await svc.VersionService.getLatestVersion(id)
    const permissions = await svc.ProjectRef.requireAccess(userId, id, 'write').then(()=>'write').catch(()=>'read')
    let root
    if (p?.rootDoc_id) {
      const paths = await svc.ProjectEntityHandler.promises.getAllDocPathsFromProjectById(id)
      root = paths[String(p.rootDoc_id)] || paths[p.rootDoc_id]
    }
    root ||= tree.find(x=>x.kind==='doc')?.path
    return { project_id:id, url:svc.ProjectRef.urlFor(id), name:p?.name, root_doc_path:root, project_version:version.version, permissions, files:tree }
  }))

  server.tool('read_file', 'Read a text file', { project: z.string(), path: z.string(), start_line: z.number().optional(), end_line: z.number().optional() }, async ({ project, path, start_line, end_line }) => run(async () => {
    const id = projectId(project, svc); await access(svc, req, id)
    const d = await svc.SnapshotService.readDoc(id, path, { startLine:start_line, endLine:end_line }); const lines = d.lines.map((line,i)=>`${(start_line||1)+i}: ${line}`).join('\n')
    const latest = svc.VersionService.getLatestVersion ? await svc.VersionService.getLatestVersion(id) : null
    return { path:d.path, content:lines, lines:d.lines, project_version:latest?.version ?? d.docVersion, sha256:d.sha256, total_lines:d.totalLines }
  }))

  server.tool('get_outline', 'Get LaTeX outline', { project: z.string(), path: z.string().optional() }, async ({ project, path }) => run(async () => {
    const id=projectId(project,svc); await access(svc,req,id); const tree=await svc.SnapshotService.getFileTree(id); const root=path || tree.find(x=>x.kind==='doc')?.path; const docs=[]
    if (root) docs.push(root)
    if (!path) { const r=await svc.SnapshotService.readDoc(id,root,{}); for(const l of r.lines){ const m=l.match(/\\(?:input|include)\{([^}]+)\}/); if(m) docs.push(m[1].endsWith('.tex')?m[1]:m[1]+'.tex') } }
    const out=[]; for(const p of docs){ try { const d=await svc.SnapshotService.readDoc(id,p,{}); d.lines.forEach((line,i)=>{ const m=line.match(/^\s*\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/); if(m) out.push({path:p,line:i+1,level:m[1],title:m[2]}) }) } catch {} }
    return out
  }))

  server.tool('search', 'Search project files', { project: z.string(), query: z.string(), regex: z.boolean().optional(), max_results: z.number().optional() }, async ({ project, query, regex, max_results=50 }) => run(async () => {
    const id=projectId(project,svc); await access(svc,req,id); const tree=await svc.SnapshotService.getFileTree(id); const re=regex?new RegExp(query):null; const out=[]
    for(const f of tree.filter(x=>x.kind==='doc')) { const d=await svc.SnapshotService.readDoc(id,f.path,{}); d.lines.forEach((text,i)=>{ if((re?re.test(text):text.includes(query))&&out.length<max_results) out.push({path:f.path,line:i+1,text}) }) }
    return out
  }))

  server.tool('list_history', 'List project history', { project: z.string(), limit: z.number().optional() }, async ({ project, limit=50 }) => run(async () => {
    const id=projectId(project,svc); await access(svc,req,id); const labels=await svc.LabelService.listLabels(id); const updates=await fetchJson(`${Settings.apis.project_history.url}/project/${id}/updates?min_count=${limit}`); const arr=Array.isArray(updates)?updates:(updates?.updates||[])
    const normalizedLabels = (labels || []).map(l => ({ version:l.version, comment:l.comment, label:l, users:l.user_id ? [l.user_id] : (l.user ? [l.user] : []), timestamp:l.timestamp || l.createdAt, origin:l.origin || { kind:'label' } }))
    return [...normalizedLabels, ...arr].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0)).slice(0,limit)
  }))

  server.tool('diff', 'Compare project versions', { project: z.string(), from_version: z.number(), to_version: z.number(), path: z.string().optional() }, async ({ project, from_version, to_version, path }) => run(async () => { const id=projectId(project,svc); await access(svc,req,id); const url=path?`${Settings.apis.project_history.url}/project/${id}/diff?pathname=${encodeURIComponent(path)}&from=${from_version}&to=${to_version}`:`${Settings.apis.project_history.url}/project/${id}/filetree/diff?from=${from_version}&to=${to_version}`; return await fetchJson(url) }))

  server.tool('write_files', 'Write project files', { project:z.string(), message:z.string(), files:z.array(z.object({path:z.string(),content:z.string().optional(),contentBase64:z.string().optional(),delete:z.boolean().optional()})), base_version:z.number().optional(), agent:z.string().optional() }, async ({ project, message, files, base_version, agent }) => { try { const id=projectId(project,svc); await access(svc,req,id,'write'); const result=await svc.WriteService.writeFiles(id,userId,{baseVersion:base_version,message,agent:agent||clientName||'mcp',files}); return textResult(result) } catch(e) { return errorResult(e, e.code==='version_conflict'?`re-read changed files and retry with base_version=${e.actualVersion}`:undefined) } })
  return server
}

export function createMcpServer(options={}) { const server = new McpServer({ name:'overleaf-mcp', version:'1.0.0' }); registerTools(server, options); return server }

async function handle(req,res) { const server=createMcpServer({ req }); const transport=new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); await server.connect(transport); return transport.handleRequest(req,res,req.body) }

const McpModule = { dependencies:['project-sync'], nonCsrfRouter:{ apply(webRouter, privateApiRouter, publicApiRouter) { const middleware=requireAccessToken('mcp'); publicApiRouter.post('/mcp', middleware, handle); publicApiRouter.get('/mcp', middleware, handle); publicApiRouter.delete('/mcp', middleware, handle) } } }
export default McpModule
