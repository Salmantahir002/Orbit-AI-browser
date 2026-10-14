from pathlib import Path
from xml.sax.saxutils import escape
import json

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(__file__).resolve().parent
W, H, BW = 2540, 2080, 440
COLS = [60, 550, 1040, 1530, 2020]
ROWS = [150, 500, 850, 1200, 1550]
PALETTE = {'browser':'#dcecf8','agent':'#e7def2','detection':'#def1e8','provider':'#fff0d5','module':'#fde2e0'}
NODES = {}

def node(name, c, r, group, attrs, methods, stereotype='', height=270):
    NODES[name] = {'name':name,'x':COLS[c],'y':ROWS[r],'w':BW,'h':height,'group':group,'attrs':attrs,'methods':methods,'stereotype':stereotype}

node('BrowserUIController',0,0,'browser', ['+ profile: BrowserProfileStore','- surfaces: Map<number, WindowSurface>','- liveDownloads: Map<string, DownloadItem>'], ['+ attach(window, shellLoaded): Promise<void>','+ setActiveTarget(window, id): void','+ getPageZoom(contents?): number'])
node('BrowserProfileStore',0,1,'browser', ['+ history: HistoryEntry[]','+ bookmarks: Bookmark[]','+ downloads: DownloadEntry[]','+ settings: BrowserSettings'], ['+ snapshot(): BrowserSnapshot','+ recordVisit(url, title): string | null','+ saveBookmark(value): void','+ flush(): void'],height=290)
node('CdpSessionRegistry',0,2,'browser',['- sessions: Map<number, CdpSession>'],['+ attach(contents): CdpSession | null','+ get(targetId): CdpSession | undefined'],height=220)
node('CdpSession',0,3,'browser',['+ targetId: number','- contents: WebContents','- enabledDomains: Set<string>'],['+ attach(contents): CdpSession | null {static}','+ send(method, params?, timeoutMs?): Promise','+ isAlive(): boolean','+ enableDomains(domains, params?): Promise'],height=290)

node('AgentTask',1,0,'agent',['+ taskId: string','+ goal: string','- targetId: number','- memory: AgentWorkingMemory'],['+ run(): Promise<AgentTaskResult>','- executeQueue(plan, pageState): Promise','- finalResult(status, message, reason?)'],height=290)
node('AgentWorkingMemory',1,1,'agent',['+ goal: string','- completedSteps: AgentStepRecord[]','- failures: AgentFailureRecord[]','- contentLedger: LedgerEntry[]'],['+ recordStep(tool, summary, succeeded?): void','+ recordFailure(tool, reason, code?): void','+ snapshot(): AgentWorkingMemorySnapshot'],height=290)
node('AgentSessionMemory',1,2,'agent',['- tasks: AgentSessionTaskRecord[]'],['+ record(task): void','+ history(): AgentSessionTaskRecord[]','+ clear(): void'],height=230)
node('LlmProviderManager',1,3,'provider',['- activeConfig: ProviderConfig | null','- activeGateway: ProviderGateway | null'],['+ setActiveProvider(config): void','+ chat(params): Promise<ChatResponse>','+ planChat(params): Promise<string>'],height=270)

node('AgentPlannerService',2,0,'agent',['+ isConfigured: boolean {get}','+ model: string {get}'],['+ buildMessages(goal, memory, state): Array','+ requestPlan(goal, memory, state): Promise','+ parsePlan(raw, knownElementIds?): ParsedPlan'])
node('BrowserRuntime',2,1,'browser',['- targets: Map<number, CdpSession>','- elementHandles: Map<number, Map>','- actionCounter: number'],['+ registerTarget(session): void','+ unregisterTarget(targetId): void','+ invoke(targetId, name, params): Promise'])
node('CdpInspectionService',2,2,'browser',['- states: Map<number, InspectionState>'],['+ watch(session): void','+ forget(targetId): void','+ capture(webContentsId): Promise'],height=230)
node('ProviderGateway',2,3,'provider',['+ config: ProviderConfig {readonly}'],['+ listModels(): Promise<ModelInfo[]> {abstract}','+ chatCompletion(messages, options?): Promise','+ validateKey(): Promise<boolean> {abstract}'],stereotype='abstract',height=270)

node('security.routes.ts',3,0,'module',[],['+ analyzeText(rawText, source, contentSources?)','  : Promise<SecurityCheckResponse>','+ securityRoutes(app): Promise<void>'],stereotype='module',height=230)
node('PromptClassifierService',3,1,'detection',['- _modelLoaded: boolean','- _ready: Promise<void>'],['+ ready(): Promise<void>','+ classify(text): Promise<ClassifyResult>','+ classifyMany(texts): Promise<ClassifyResult[]>'])
node('RuleBasedDetectorService',3,2,'detection',[],['+ detect(text): DetectResult'],height=190)

node('PromptPreprocessingService',4,0,'detection',[],['+ preprocess(text): PreprocessResult'],height=190)
node('TextChunkingService',4,1,'detection',[],['+ chunkText(text, chunkSize, overlap)','  : TextChunk[]'],height=200)
node('FeatureExplanationService',4,2,'detection',[],['+ extractFeatures(text, patternEvidence)','  : FeatureEvidence'],height=200)

for name,c in [('OpenAICompatibleGateway',1),('AnthropicGateway',2),('GeminiGateway',3)]:
    node(name,c,4,'provider',['+ baseUrl: string {readonly}'],['+ listModels(): Promise<ModelInfo[]>','+ chatCompletion(messages, options?): Promise','+ validateKey(): Promise<boolean>'],height=245)

EDGES = []
def edge(a,b,kind,points,label='',lx=0,ly=0,mults=None):
    EDGES.append({'a':a,'b':b,'kind':kind,'points':points,'label':label,'lx':lx,'ly':ly,'mults':mults})

# Route links through spaces between the class boxes. Arrowheads point to the supplier.
edge('BrowserUIController','BrowserProfileStore','composition',[(280,420),(280,500)],'owns',318,466,mults=[(255,445,'1'),(255,490,'1')])
edge('AgentTask','AgentWorkingMemory','composition',[(770,440),(770,500)],'',0,0,mults=[(745,462,'1'),(745,490,'1')])
edge('AgentTask','AgentSessionMemory','dependency',[(550,285),(522,285),(522,970),(550,970)],'uses shared memory',485,835)
edge('AgentTask','AgentPlannerService','dependency',[(990,245),(1040,245)],'HTTP',1017,224)
edge('AgentTask','BrowserRuntime','dependency',[(990,350),(1018,350),(1018,470),(1260,470),(1260,500)],'preload IPC',1150,456)
edge('AgentPlannerService','LlmProviderManager','dependency',[(1040,380),(1006,380),(1006,1355),(990,1355)],'uses',978,1178)
edge('BrowserRuntime','CdpInspectionService','dependency',[(1260,770),(1260,850)],'capture callback',1336,817)
edge('CdpSessionRegistry','CdpSession','aggregation',[(280,1070),(280,1200)],'stores',320,1150,mults=[(254,1100,'1'),(244,1184,'0..*')])
edge('BrowserRuntime','CdpSession','association',[(1040,655),(1028,655),(1028,815),(40,815),(40,1300),(60,1300)],'borrows sessions',283,805)
edge('CdpInspectionService','CdpSession','association',[(1260,1080),(1260,1150),(520,1150),(520,1375),(500,1375)],'shares sessions',1125,1135)
# Complete the endpoint at the session box's right edge (x=500).
edge('security.routes.ts','PromptPreprocessingService','dependency',[(1970,245),(2020,245)],'uses',1995,224)
edge('security.routes.ts','TextChunkingService','dependency',[(1970,295),(1988,295),(1988,595),(2020,595)],'',0,0)
edge('security.routes.ts','FeatureExplanationService','dependency',[(1970,345),(2004,345),(2004,945),(2020,945)],'',0,0)
edge('security.routes.ts','PromptClassifierService','dependency',[(1750,380),(1750,500)],'classifies',1810,447)
edge('PromptClassifierService','RuleBasedDetectorService','dependency',[(1750,770),(1750,850)],'uses rules',1810,816)
edge('LlmProviderManager','ProviderGateway','association',[(990,1315),(1040,1315)],'',0,0,mults=[(1005,1291,'0..1')])
edge('OpenAICompatibleGateway','ProviderGateway','inheritance',[(770,1550),(770,1510),(1170,1510),(1170,1470)])
edge('AnthropicGateway','ProviderGateway','inheritance',[(1260,1550),(1260,1470)])
edge('GeminiGateway','ProviderGateway','inheritance',[(1750,1550),(1750,1510),(1350,1510),(1350,1470)])

svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', '<rect width="100%" height="100%" fill="white"/>', '''<defs>
<marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M1,1 L10,6 L1,11" fill="none" stroke="#59636f" stroke-width="2"/></marker>
<marker id="triangle" markerWidth="19" markerHeight="18" refX="17" refY="9" orient="auto" markerUnits="userSpaceOnUse"><path d="M1,1 L17,9 L1,17 Z" fill="white" stroke="#59636f" stroke-width="2"/></marker>
</defs>''']
def text(x,y,value,size=21,anchor='start',weight='normal',italic=False):
    svg.append(f'<text x="{x}" y="{y}" font-family="Times New Roman, serif" font-size="{size}" text-anchor="{anchor}" font-weight="{weight}" font-style="{"italic" if italic else "normal"}" fill="#17202a">{escape(value)}</text>')

text(W/2,58,'Class Diagram for Orbit',38,'middle','bold')
text(W/2,96,'Prompt Injection Defense in an AI Native Browser',26,'middle')
for e in EDGES:
    points=e['points']
    if points[-1] == points[-2]: points=points[:-1]
    d='M '+' L '.join(f'{x},{y}' for x,y in points)
    marker='triangle' if e['kind']=='inheritance' else 'arrow'
    dash=' stroke-dasharray="9 6"' if e['kind']=='dependency' else ''
    svg.append(f'<path d="{d}" fill="none" stroke="#59636f" stroke-width="2.1"{dash} marker-end="url(#{marker})"/>')
    if e['kind'] in ('composition','aggregation'):
        x,y=points[0]; fill='#59636f' if e['kind']=='composition' else 'white'
        svg.append(f'<path d="M{x},{y} l-8,12 l8,12 l8,-12 Z" fill="{fill}" stroke="#59636f" stroke-width="2"/>')

for n in NODES.values():
    x,y,w,h=n['x'],n['y'],n['w'],n['h']
    attrs=n['attrs']; methods=n['methods']
    head=65 if n['stereotype'] else 48
    attrheight=max(32,25*len(attrs)+14)
    divider=y+head+attrheight
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2" fill="{PALETTE[n["group"]]}" stroke="#677681" stroke-width="2"/>')
    if n['stereotype']:
        text(x+w/2,y+23,'«'+n['stereotype']+'»',19,'middle',italic=True)
        text(x+w/2,y+49,n['name'],25,'middle','bold',n['stereotype']=='abstract')
    else: text(x+w/2,y+32,n['name'],25,'middle','bold')
    svg.append(f'<path d="M{x},{y+head} H{x+w} M{x},{divider} H{x+w}" stroke="#829099" stroke-width="1.4" fill="none"/>')
    for i,t in enumerate(attrs): text(x+14,y+head+29+i*25,t,20)
    for i,t in enumerate(methods): text(x+14,divider+30+i*27,t,20)

# Labels are drawn after the boxes, all positioned in the routing gaps.
for e in EDGES:
    if e['label']: text(e['lx'],e['ly'],e['label'],19,'middle',italic=True)
    if e['mults']:
        for x,y,t in e['mults']: text(x,y,t,20,'middle')

# Empty space beside the provider family holds a compact key and implementation note.
text(2020,1240,'UML notation',25,weight='bold')
text(2020,1278,'+ public member    - private member',21)
text(2020,1310,'Dashed arrow: dependency',21)
text(2020,1342,'Solid arrow: association',21)
text(2020,1374,'Filled diamond: composition',21)
text(2020,1406,'Open diamond: aggregation',21)
text(2020,1438,'Open triangle: inheritance',21)
text(60,1590,'Implementation notes',25,weight='bold')
notes=['Selected classes and members are shown.','Long parameter and return types are abbreviated.','React components and TypeScript data interfaces','are not represented as execution classes.','The local classifier uses ONNX helper functions.','Agent Mode does not automatically invoke it.']
for i,t in enumerate(notes): text(60,1630+i*31,t,21)
text(W/2,1882,'Class Diagram for the Orbit Browser',29,'middle','bold',True)
text(W/2,1926,'Shared CDP sessions support browser actions and manual capture; HTTP and IPC dependencies cross process boundaries.',22,'middle')
text(W/2,1964,'Blue: browser control     Purple: agent execution     Green: detection     Yellow: AI providers     Pink: functional module',22,'middle')
svg.append('</svg>')
(ROOT / 'Orbit_Class_Design.svg').write_text('\n'.join(svg),encoding='utf-8')

# The editable UML source uses the same nodes and relationship semantics.
mmd=['---','config:','  theme: base','  themeVariables:','    fontFamily: Times New Roman','    primaryTextColor: "#17202a"','---','classDiagram','direction TB']
for name,n in NODES.items():
    ident='SecurityRoutes' if name=='security.routes.ts' else name
    if name=='security.routes.ts': mmd.append('class SecurityRoutes["security.routes.ts"]')
    mmd.append(f'class {ident} {{')
    if n['stereotype']:mmd.append('  <<'+n['stereotype']+'>>')
    for t in n['attrs']:
        # Mermaid generics use tildes. Retain selected field names and simple type names.
        visibility=t[0]; body=t[2:].split(' {')[0]
        field,typ=body.split(': ',1)
        typ=typ.split('<')[0].replace(' | ','Or')
        mmd.append(f'  {visibility}{typ} {field}')
    for t in n['methods']:
        if t.startswith('+') or t.startswith('-'):
            visibility=t[0]; signature=t[2:].split(': ')[0].split(' {')[0]
            mmd.append(f'  {visibility}{signature}')
    mmd.append('}')
    mmd.append(f'style {ident} fill:{PALETTE[n["group"]]},stroke:#677681,color:#17202a')
for e in EDGES:
    a='SecurityRoutes' if e['a']=='security.routes.ts' else e['a']; b=e['b']
    if e['kind']=='inheritance':mmd.append(f'{b} <|-- {a}')
    elif e['kind']=='composition':mmd.append(f'{a} "1" *-- "1" {b}')
    elif e['kind']=='aggregation':mmd.append(f'{a} "1" o-- "0..*" {b}')
    else:
        op='..>' if e['kind']=='dependency' else '-->'
        suffix=' : '+e['label'] if e['label'] else ''
        mmd.append(f'{a} {op} {b}{suffix}')
(ROOT/'Orbit_Class_Design.mmd').write_text('\n'.join(mmd)+'\n',encoding='utf-8')
(WORK/'diagram-model.json').write_text(json.dumps({'nodes':NODES,'edges':EDGES},indent=2),encoding='utf-8')
print('Created SVG and editable Mermaid class diagram')
