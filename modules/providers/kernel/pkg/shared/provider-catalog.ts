// 共享供应商目录。品牌收录与查询能力是两件事：目录负责识别和分组，
// queryKind 只标记已经有确定协议实现的查询后端。
//
// 主目录以 cc-switch 0b5da510168914b251481654a568c3ffacd62cf4 的
// Claude Code 77 个原始预设为固定快照，再通过 brandId 归并品牌；
// ZenMux 来自同一提交的 coding_plan 实现。

export type ProviderGroup = 'official' | 'relay';

/** 内部维护分类；不参与 Pi 界面渲染。 */
export type ProviderCategory = 'official' | 'major-relay' | 'small-relay' | 'unknown';
export type MaintenancePriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ProviderQueryStatus = 'implemented' | 'recognition-only';

export const UNKNOWN_PROVIDER_METADATA = Object.freeze({
	category: 'unknown' as const,
	maintenancePriority: 'P3' as const,
	queryStatus: 'recognition-only' as const,
});

export type BuiltinQueryKind =
	| 'claude-subscription'
	| 'codex-subscription'
	| 'gemini-subscription'
	| 'copilot-subscription'
	| 'grok-subscription'
	| 'zhipu'
	| 'kimi-api'
	| 'kimi-coding'
	| 'volcengine-agent'
	| 'volcengine-coding'
	| 'minimax-cn'
	| 'minimax-en'
	| 'deepseek'
	| 'stepfun'
	| 'siliconflow-cn'
	| 'siliconflow-en'
	| 'openrouter'
	| 'novita'
	| 'sub2api';

/** 查询所需凭据来源；none 表示目前只有品牌识别，没有确定的查询协议。 */
export type QueryAccess = 'api-key' | 'extra-credentials' | 'host-oauth' | 'generic' | 'none';

export interface ProviderRoute {
	/** 精确主机名；以 *. 开头时允许该域及其子域。 */
	host: string;
	/** 同一主机承载多个产品时，用路径前缀消歧。 */
	pathPrefix?: string;
}

export interface ProviderCatalogEntry {
	/** 路由/产品变体标识；同一品牌的国内站、国际站或套餐可以各自拥有独立条目。 */
	id: string;
	/** 去重后的品牌标识；界面和跨宿主统计以此为准。 */
	brandId: string;
	displayName: string;
	group: ProviderGroup;
	/** 内部维护字段；不得传入状态栏或 Header 的展示数据。 */
	category: Exclude<ProviderCategory, 'unknown'>;
	maintenancePriority: Exclude<MaintenancePriority, 'P3'>;
	queryStatus: ProviderQueryStatus;
	/** 仅描述站点、套餐或鉴权差异，不作为供应商品牌展示。 */
	variant?: string;
	/** cc-switch 中的原始预设名称；非预设查询后端为空。 */
	presetName?: string;
	/** 其它宿主中指向同一计费服务的预设名称。 */
	aliases?: readonly string[];
	routes: readonly ProviderRoute[];
	queryAccess: QueryAccess;
	queryKind?: BuiltinQueryKind;
}

export interface ProviderBrand {
	id: string;
	displayName: string;
	group: ProviderGroup;
	variants: readonly ProviderCatalogEntry[];
}

const route = (host: string, pathPrefix?: string): ProviderRoute => ({ host, pathPrefix });

// 分类是维护者审核结果，不根据域名、价格或模型数量自动推断。
const BRAND_METADATA = {
	anthropic: { displayName: 'Anthropic', category: 'official' },
	kimi: { displayName: 'Kimi', category: 'official' },
	volcengine: { displayName: 'Volcengine', category: 'official' },
	byteplus: { displayName: 'BytePlus', category: 'official' },
	'doubao-seed': { displayName: 'Doubao', category: 'official' },
	gemini: { displayName: 'Gemini', category: 'official' },
	deepseek: { displayName: 'DeepSeek', category: 'official' },
	zhipu: { displayName: 'Zhipu', category: 'official' },
	'baidu-qianfan': { displayName: 'Baidu', category: 'official' },
	bailian: { displayName: 'Bailian', category: 'official' },
	stepfun: { displayName: 'StepFun', category: 'official' },
	'kat-coder': { displayName: 'KAT-Coder', category: 'official' },
	longcat: { displayName: 'LongCat', category: 'official' },
	minimax: { displayName: 'MiniMax', category: 'official' },
	bailing: { displayName: 'BaiLing', category: 'official' },
	'github-copilot': { displayName: 'GitHub', category: 'official' },
	codex: { displayName: 'OpenAI', category: 'official' },
	xai: { displayName: 'xAI', category: 'official' },
	'xiaomi-mimo': { displayName: 'Xiaomi', category: 'official' },
	'aws-bedrock': { displayName: 'AWS', category: 'official' },
	openai: { displayName: 'OpenAI', category: 'official' },
	'azure-openai': { displayName: 'Azure', category: 'official' },
	'tencent-hunyuan': { displayName: 'Tencent', category: 'official' },
	'nous-research': { displayName: 'Nous Research', category: 'official' },
	packycode: { displayName: 'PackyCode', category: 'small-relay' },
	zetaapi: { displayName: 'ZetaAPI', category: 'small-relay' },
	apinebula: { displayName: 'APINebula', category: 'small-relay' },
	aicodemirror: { displayName: 'AICodeMirror', category: 'small-relay' },
	patewayai: { displayName: 'PatewayAI', category: 'small-relay' },
	fennoai: { displayName: 'FennoAI', category: 'small-relay' },
	runapi: { displayName: 'RunAPI', category: 'small-relay' },
	shengsuanyun: { displayName: 'Shengsuanyun', category: 'small-relay' },
	aigocode: { displayName: 'AIGoCode', category: 'small-relay' },
	qiniu: { displayName: 'Qiniu', category: 'small-relay' },
	aicoding: { displayName: 'AICoding', category: 'small-relay' },
	subrouter: { displayName: 'SubRouter', category: 'small-relay' },
	apikey: { displayName: 'ApiKey', category: 'small-relay' },
	claudeapi: { displayName: 'ClaudeAPI', category: 'small-relay' },
	code0: { displayName: 'Code0', category: 'small-relay' },
	teamorouter: { displayName: 'TeamoRouter', category: 'small-relay' },
	ppio: { displayName: 'PPIO', category: 'small-relay' },
	claudecn: { displayName: 'ClaudeCN', category: 'small-relay' },
	siliconflow: { displayName: 'SiliconFlow', category: 'major-relay' },
	a6api: { displayName: 'A6API', category: 'small-relay' },
	atlascloud: { displayName: 'AtlasCloud', category: 'small-relay' },
	compshare: { displayName: 'Compshare', category: 'small-relay' },
	ccsub: { displayName: 'CCSub', category: 'small-relay' },
	sssaicode: { displayName: 'SSSAiCode', category: 'small-relay' },
	micu: { displayName: 'Micu', category: 'small-relay' },
	rightcode: { displayName: 'RightCode', category: 'small-relay' },
	etok: { displayName: 'ETok', category: 'small-relay' },
	cubence: { displayName: 'Cubence', category: 'small-relay' },
	crazyrouter: { displayName: 'CrazyRouter', category: 'small-relay' },
	dmxapi: { displayName: 'DMXAPI', category: 'small-relay' },
	sudocode: { displayName: 'SudoCode', category: 'small-relay' },
	xycai: { displayName: 'XycAi', category: 'small-relay' },
	amux: { displayName: 'Amux', category: 'small-relay' },
	'opencode-go': { displayName: 'OpenCode Go', category: 'small-relay' },
	modelscope: { displayName: 'ModelScope', category: 'major-relay' },
	aihubmix: { displayName: 'AiHubMix', category: 'major-relay' },
	cherryin: { displayName: 'CherryIN', category: 'small-relay' },
	relaxycode: { displayName: 'RelaxyCode', category: 'small-relay' },
	eflowcode: { displayName: 'E-FlowCode', category: 'small-relay' },
	openrouter: { displayName: 'OpenRouter', category: 'major-relay' },
	therouter: { displayName: 'TheRouter', category: 'small-relay' },
	novita: { displayName: 'Novita', category: 'major-relay' },
	nvidia: { displayName: 'NVIDIA', category: 'small-relay' },
	pipellm: { displayName: 'PIPELLM', category: 'small-relay' },
	jiekou: { displayName: 'JieKou', category: 'small-relay' },
	zenmux: { displayName: 'ZenMux', category: 'major-relay' },
	'together-ai': { displayName: 'Together', category: 'major-relay' },
	'new-api': { displayName: 'New API', category: 'small-relay' },
} as const satisfies Record<string, Pick<ProviderCatalogEntry, 'displayName' | 'category'>>;

type ProviderVariant = Pick<ProviderCatalogEntry, 'id' | 'routes' | 'presetName' | 'variant' | 'aliases' | 'queryKind'> & {
	brandId: keyof typeof BRAND_METADATA;
	queryAccess?: QueryAccess;
};

const PROVIDER_VARIANTS: readonly ProviderVariant[] = [
	{ id: 'anthropic', brandId: 'anthropic', presetName: 'Claude Official', routes: [route('api.anthropic.com')], queryAccess: 'host-oauth', queryKind: 'claude-subscription', aliases: ['Claude Desktop Official'] },
	{
		id: 'kimi-api-cn', brandId: 'kimi', presetName: 'Kimi', variant: 'API (China)',
		routes: [route('api.moonshot.cn')], queryAccess: 'api-key', queryKind: 'kimi-api',
	},
	{
		id: 'kimi-api-en', brandId: 'kimi', variant: 'API (International)',
		routes: [route('api.moonshot.ai')], queryAccess: 'api-key', queryKind: 'kimi-api',
	},
	{
		id: 'kimi', brandId: 'kimi', presetName: 'Kimi For Coding', variant: 'Coding Plan',
		routes: [route('api.kimi.com', '/coding')], queryAccess: 'api-key', queryKind: 'kimi-coding',
	},
	{
		id: 'volcengine-agent-plan', brandId: 'volcengine', presetName: '火山 Agent Plan', variant: 'Agent Plan',
		routes: [route('ark.cn-beijing.volces.com', '/api/plan')], queryAccess: 'extra-credentials', queryKind: 'volcengine-agent', aliases: ['火山Agentplan'],
	},
	{
		id: 'volcengine-coding-plan', brandId: 'volcengine', presetName: '火山 Coding Plan', variant: 'Coding Plan',
		routes: [route('ark.cn-beijing.volces.com', '/api/coding')], queryAccess: 'extra-credentials', queryKind: 'volcengine-coding',
	},
	{ id: 'byteplus', brandId: 'byteplus', presetName: 'BytePlus', routes: [route('ark.ap-southeast.bytepluses.com')] },
	{ id: 'doubao-seed', brandId: 'doubao-seed', presetName: 'DouBaoSeed', routes: [route('ark.cn-beijing.volces.com')] },
	{ id: 'gemini', brandId: 'gemini', presetName: 'Gemini Native', routes: [route('generativelanguage.googleapis.com')], queryAccess: 'host-oauth', queryKind: 'gemini-subscription', aliases: ['Google Official'] },
	{ id: 'deepseek', brandId: 'deepseek', presetName: 'DeepSeek', routes: [route('api.deepseek.com')], queryAccess: 'api-key', queryKind: 'deepseek' },
	{ id: 'zhipu', brandId: 'zhipu', presetName: 'Zhipu GLM', variant: 'China', routes: [route('*.bigmodel.cn')], queryAccess: 'api-key', queryKind: 'zhipu' },
	{ id: 'z.ai', brandId: 'zhipu', presetName: 'Zhipu GLM en', variant: 'International', routes: [route('api.z.ai')], queryAccess: 'api-key', queryKind: 'zhipu' },
	{ id: 'baidu-qianfan-coding', brandId: 'baidu-qianfan', presetName: 'Baidu Qianfan Coding Plan', variant: 'Coding Plan', routes: [route('qianfan.baidubce.com', '/anthropic/coding')] },
	{ id: 'baidu-qianfan-token-plan', brandId: 'baidu-qianfan', presetName: 'Baidu Qianfan Token Plan', variant: 'Token Plan', routes: [route('qianfan.baidubce.com', '/anthropic/tokenplan')] },
	{ id: 'bailian', brandId: 'bailian', presetName: 'Bailian', variant: 'API', routes: [route('dashscope.aliyuncs.com')], aliases: ['Qwen Coder'] },
	{ id: 'bailian-coding', brandId: 'bailian', presetName: 'Bailian For Coding', variant: 'Coding Plan', routes: [route('coding.dashscope.aliyuncs.com')] },
	{ id: 'stepfun-cn', brandId: 'stepfun', presetName: 'StepFun', variant: 'China', routes: [route('api.stepfun.com')], queryAccess: 'api-key', queryKind: 'stepfun', aliases: ['StepFun Step Plan'] },
	{ id: 'stepfun-en', brandId: 'stepfun', presetName: 'StepFun en', variant: 'International', routes: [route('api.stepfun.ai')], queryAccess: 'api-key', queryKind: 'stepfun' },
	{ id: 'kat-coder', brandId: 'kat-coder', presetName: 'KAT-Coder', routes: [route('vanchin.streamlake.ai')] },
	{ id: 'longcat', brandId: 'longcat', presetName: 'Longcat', routes: [route('api.longcat.chat')] },
	{ id: 'minimax-cn', brandId: 'minimax', presetName: 'MiniMax', variant: 'China', routes: [route('api.minimaxi.com')], queryAccess: 'api-key', queryKind: 'minimax-cn' },
	{ id: 'minimax-en', brandId: 'minimax', presetName: 'MiniMax en', variant: 'International', routes: [route('api.minimax.io')], queryAccess: 'api-key', queryKind: 'minimax-en' },
	{ id: 'bailing', brandId: 'bailing', presetName: 'BaiLing', routes: [route('api.tbox.cn')] },
	{ id: 'github-copilot', brandId: 'github-copilot', presetName: 'GitHub Copilot', routes: [route('api.githubcopilot.com')], queryAccess: 'host-oauth', queryKind: 'copilot-subscription' },
	{ id: 'codex', brandId: 'codex', presetName: 'Codex', routes: [route('chatgpt.com', '/backend-api')], queryAccess: 'host-oauth', queryKind: 'codex-subscription', aliases: ['openai-codex'] },
	{ id: 'xai', brandId: 'xai', presetName: 'xAI (Grok)', routes: [route('api.x.ai')], queryAccess: 'host-oauth', queryKind: 'grok-subscription', aliases: ['xAI (Grok) OAuth'] },
	{ id: 'xiaomi-mimo', brandId: 'xiaomi-mimo', presetName: 'Xiaomi MiMo', variant: 'API', routes: [route('api.xiaomimimo.com')] },
	{ id: 'xiaomi-mimo-token-plan', brandId: 'xiaomi-mimo', presetName: 'Xiaomi MiMo Token Plan (China)', variant: 'Token Plan (China)', routes: [route('token-plan-cn.xiaomimimo.com')] },
	{ id: 'aws-bedrock-aksk', brandId: 'aws-bedrock', presetName: 'AWS Bedrock (AKSK)', variant: 'AK/SK', routes: [route('bedrock-runtime.*.amazonaws.com')] },
	{ id: 'aws-bedrock-api-key', brandId: 'aws-bedrock', presetName: 'AWS Bedrock (API Key)', variant: 'API Key', routes: [route('bedrock-runtime.*.amazonaws.com')] },
	// cc-switch 其它宿主相对 Claude 目录新增的第一方服务。
	{ id: 'openai', brandId: 'openai', routes: [route('api.openai.com')], queryAccess: 'host-oauth', aliases: ['OpenAI Official'] },
	{ id: 'azure-openai', brandId: 'azure-openai', routes: [route('*.openai.azure.com')], aliases: ['Azure OpenAI'] },
	{ id: 'tencent-hunyuan', brandId: 'tencent-hunyuan', routes: [route('tokenhub.tencentmaas.com')], aliases: ['Tencent Hunyuan'] },
	{ id: 'nous-research', brandId: 'nous-research', routes: [route('inference-api.nousresearch.com')], aliases: ['Nous Research'] },
	{ id: 'packycode', brandId: 'packycode', presetName: 'PackyCode', routes: [route('www.packyapi.ai')] },
	{ id: 'zetaapi', brandId: 'zetaapi', presetName: 'ZetaAPI', routes: [route('api.zetaapi.ai')] },
	{ id: 'apinebula', brandId: 'apinebula', presetName: 'APINebula', routes: [route('apinebula.ai')] },
	{ id: 'aicodemirror', brandId: 'aicodemirror', presetName: 'AICodeMirror', routes: [route('api.aicodemirror.ai')] },
	{ id: 'patewayai', brandId: 'patewayai', presetName: 'PatewayAI', routes: [route('api.pateway.ai')] },
	{ id: 'fennoai', brandId: 'fennoai', presetName: 'FennoAI', routes: [route('api.fenno.ai')] },
	{ id: 'runapi', brandId: 'runapi', presetName: 'RunAPI', routes: [route('runapi.host'), route('runapi.co')] },
	{ id: 'shengsuanyun', brandId: 'shengsuanyun', presetName: 'Shengsuanyun', routes: [route('router.shengsuanyun.com')] },
	{ id: 'aigocode', brandId: 'aigocode', presetName: 'AIGoCode', routes: [route('api.aigocode.app')] },
	{ id: 'qiniu', brandId: 'qiniu', presetName: 'Qiniu', routes: [route('api.qnaigc.com')] },
	{ id: 'aicoding', brandId: 'aicoding', presetName: 'AICoding', routes: [route('api.aicoding.inc')] },
	{ id: 'subrouter', brandId: 'subrouter', presetName: 'SubRouter', routes: [route('subrouter.ai')] },
	{ id: 'apikey', brandId: 'apikey', presetName: 'APIKEY.FUN', routes: [route('api.apikey.fun'), route('slb.apikey.fun')], queryAccess: 'api-key', queryKind: 'sub2api', aliases: ['apikey.fun'] },
	{ id: 'claudeapi', brandId: 'claudeapi', presetName: 'ClaudeAPI', routes: [route('gw.apito.ai')] },
	{ id: 'code0', brandId: 'code0', presetName: 'Code0', routes: [route('code0.ai')] },
	{ id: 'teamorouter', brandId: 'teamorouter', presetName: 'TeamoRouter', routes: [route('api.teamorouter.cn'), route('api.teamorouter.com')] },
	{ id: 'ppio', brandId: 'ppio', presetName: 'PPIO', routes: [route('api.ppio.com')] },
	{ id: 'claudecn', brandId: 'claudecn', presetName: 'ClaudeCN', routes: [route('claudecn.top')] },
	{ id: 'siliconflow-cn', brandId: 'siliconflow', presetName: 'SiliconFlow', variant: 'China', routes: [route('api.siliconflow.cn')], queryAccess: 'api-key', queryKind: 'siliconflow-cn' },
	{ id: 'siliconflow-en', brandId: 'siliconflow', presetName: 'SiliconFlow en', variant: 'International', routes: [route('api.siliconflow.com')], queryAccess: 'api-key', queryKind: 'siliconflow-en' },
	{ id: 'a6api', brandId: 'a6api', presetName: 'A6API', routes: [route('api.a6api.com')] },
	{ id: 'atlascloud', brandId: 'atlascloud', presetName: 'AtlasCloud', routes: [route('api.atlascloud.ai')] },
	{ id: 'compshare', brandId: 'compshare', presetName: 'Compshare', variant: 'API', routes: [route('api.modelverse.cn')] },
	{ id: 'compshare-coding', brandId: 'compshare', presetName: 'Compshare Coding Plan', variant: 'Coding Plan', routes: [route('cp.compshare.cn')] },
	{ id: 'ccsub', brandId: 'ccsub', presetName: 'CCSub', routes: [route('www.ccsub.net')] },
	{ id: 'sssaicode', brandId: 'sssaicode', presetName: 'SSSAiCode', routes: [route('node-hk.sssaicodeapi.com')] },
	{ id: 'micu', brandId: 'micu', presetName: 'Micu', routes: [route('www.micuapi.ai')] },
	{ id: 'rightcode', brandId: 'rightcode', presetName: 'RightCode', routes: [route('www.rightapi.ai')] },
	{ id: 'etok', brandId: 'etok', presetName: 'ETok.ai', routes: [route('api.etok.ai')] },
	{ id: 'cubence', brandId: 'cubence', presetName: 'Cubence', routes: [route('api.cubence.com')] },
	{ id: 'crazyrouter', brandId: 'crazyrouter', presetName: 'CrazyRouter', routes: [route('cn.crazyrouter.com')] },
	{ id: 'dmxapi', brandId: 'dmxapi', presetName: 'DMXAPI', routes: [route('www.dmxapi.cn')] },
	{ id: 'sudocode-chat', brandId: 'sudocode', presetName: 'SudoCode.chat', variant: '.chat', routes: [route('api.sudocode.chat')] },
	{ id: 'sudocode-us', brandId: 'sudocode', presetName: 'SudoCode.us', variant: '.us', routes: [route('sudocode.us')] },
	{ id: 'xycai', brandId: 'xycai', presetName: 'XycAi', routes: [route('apicdn.xycai.us')] },
	{ id: 'amux', brandId: 'amux', presetName: 'Amux', routes: [route('api.amux.ai')] },
	{ id: 'opencode-go', brandId: 'opencode-go', presetName: 'OpenCode Go', routes: [route('opencode.ai', '/zen/go')] },
	{ id: 'modelscope', brandId: 'modelscope', presetName: 'ModelScope', routes: [route('api-inference.modelscope.cn')] },
	{ id: 'aihubmix', brandId: 'aihubmix', presetName: 'AiHubMix', routes: [route('aihubmix.com')] },
	{ id: 'cherryin', brandId: 'cherryin', presetName: 'CherryIN', routes: [route('open.cherryin.net')] },
	{ id: 'relaxycode', brandId: 'relaxycode', presetName: 'RelaxyCode', routes: [route('www.relaxycode.com')] },
	{ id: 'eflowcode', brandId: 'eflowcode', presetName: 'E-FlowCode', routes: [route('e-flowcode.cc')] },
	{ id: 'openrouter', brandId: 'openrouter', presetName: 'OpenRouter', routes: [route('openrouter.ai')], queryAccess: 'api-key', queryKind: 'openrouter' },
	{ id: 'therouter', brandId: 'therouter', presetName: 'TheRouter', routes: [route('api.therouter.ai')] },
	{ id: 'novita', brandId: 'novita', presetName: 'Novita AI', routes: [route('api.novita.ai')], queryAccess: 'api-key', queryKind: 'novita' },
	{ id: 'nvidia', brandId: 'nvidia', presetName: 'Nvidia', routes: [route('integrate.api.nvidia.com')] },
	{ id: 'pipellm', brandId: 'pipellm', presetName: 'PIPELLM', routes: [route('cc-api.pipellm.ai')] },
	{ id: 'jiekou', brandId: 'jiekou', presetName: 'JieKou AI', routes: [route('api.jiekou.ai')] },
	// 同一参考提交内有专用 Coding Plan 查询，但没有 Claude 预设。
	{ id: 'zenmux', brandId: 'zenmux', routes: [route('*.zenmux.ai')] },
	// cc-switch 其它宿主相对 Claude 目录新增的聚合/网关服务。
	{ id: 'together-ai', brandId: 'together-ai', routes: [route('api.together.xyz')], aliases: ['Together AI'] },
	{ id: 'new-api', brandId: 'new-api', routes: [], aliases: ['NewAPI'] },
];

function createCatalog(variants: readonly ProviderVariant[]): {
	entries: readonly ProviderCatalogEntry[];
	brands: readonly ProviderBrand[];
} {
	const brands = new Map(Object.entries(BRAND_METADATA).map(([id, metadata]) => [id, {
		id,
		displayName: metadata.displayName,
		group: (metadata.category === 'official' ? 'official' : 'relay') as ProviderGroup,
		variants: [] as ProviderCatalogEntry[],
	}]));
	const ids = new Map<string, ProviderCatalogEntry>();
	const entries = variants.map((variant): ProviderCatalogEntry => {
		const brand = brands.get(variant.brandId);
		if (!brand) throw new Error(`Unknown provider brand: ${variant.brandId}`);
		const { category } = BRAND_METADATA[variant.brandId];
		const entry: ProviderCatalogEntry = {
			id: variant.id,
			brandId: brand.id,
			displayName: brand.displayName,
			variant: variant.variant,
			presetName: variant.presetName,
			group: brand.group,
			routes: variant.routes,
			queryAccess: variant.queryAccess ?? (brand.group === 'official' ? 'none' : 'generic'),
			queryKind: variant.queryKind,
			aliases: variant.aliases ?? [],
			category,
			maintenancePriority: category === 'official' ? 'P0' : category === 'major-relay' ? 'P1' : 'P2',
			queryStatus: variant.queryKind ? 'implemented' : 'recognition-only',
		};
		const id = entry.id.toLowerCase();
		if (!id || id !== id.trim() || ids.has(id)) throw new Error(`Invalid or duplicate provider ID: ${entry.id}`);
		ids.set(id, entry);
		brand.variants.push(entry);
		return entry;
	});
	// ID 和别名共用查找入口，必须一起检查，避免任一条目遮住另一条目的 ID 或别名。
	const names = new Map(ids);
	for (const entry of entries) {
		for (const alias of entry.aliases ?? []) {
			const name = alias.toLowerCase();
			if (!name || name !== name.trim() || (names.has(name) && names.get(name) !== entry)) {
				throw new Error(`Unreachable provider alias: ${alias} (${entry.id})`);
			}
			names.set(name, entry);
		}
	}
	for (const brand of brands.values()) {
		if (!brand.variants.length) throw new Error(`Provider brand has no variants: ${brand.id}`);
	}
	return { entries, brands: [...brands.values()] };
}

const catalog = createCatalog(PROVIDER_VARIANTS);

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = catalog.entries;
export const OFFICIAL_PROVIDERS: readonly ProviderCatalogEntry[] = PROVIDER_CATALOG.filter((entry) => entry.group === 'official');
export const RELAY_PROVIDERS: readonly ProviderCatalogEntry[] = PROVIDER_CATALOG.filter((entry) => entry.group === 'relay');
export const PROVIDER_BRANDS: readonly ProviderBrand[] = catalog.brands;

export const CC_SWITCH_CLAUDE_PRESET_COUNT = 77;

const PROVIDER_ROUTES = PROVIDER_CATALOG.flatMap((entry) =>
	entry.routes.map((candidate) => ({ entry, candidate })),
).sort((a, b) => Number(Boolean(b.candidate.pathPrefix)) - Number(Boolean(a.candidate.pathPrefix)));

function hostMatches(hostname: string, pattern: string): boolean {
	if (!pattern.includes('*')) return hostname === pattern;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
	return new RegExp(`^${escaped}$`).test(hostname);
}

function routeMatches(url: URL, candidate: ProviderRoute): boolean {
	if (!hostMatches(url.hostname.toLowerCase(), candidate.host.toLowerCase())) return false;
	if (!candidate.pathPrefix) return true;
	const prefix = candidate.pathPrefix.toLowerCase().replace(/\/+$/, '');
	const path = url.pathname.toLowerCase().replace(/\/+$/, '');
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** 路径更具体的规则优先，避免火山 Plan 被同主机的 Doubao 通用规则抢占。 */
export function findProviderByUrl(baseUrl: string): ProviderCatalogEntry | null {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return null;
	}
	return PROVIDER_ROUTES.find(({ candidate }) => routeMatches(url, candidate))?.entry ?? null;
}

export function findProviderById(id: string): ProviderCatalogEntry | null {
	const normalized = id.trim().toLowerCase();
	return PROVIDER_CATALOG.find((entry) =>
		entry.id.toLowerCase() === normalized ||
		entry.aliases?.some((alias) => alias.toLowerCase() === normalized),
	) ?? null;
}
