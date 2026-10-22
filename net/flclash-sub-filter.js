/**
 * FlClash 订阅清洗 + 分类覆写脚本
 *
 * 用法：FlClash → 工具 → 覆写 → 新建 → 类型选「脚本」，粘贴本文件内容并启用
 * 适配：FlClash 0.9.1 的脚本引擎是 QuickJS，入口为 main(config)，只传入 config 一个参数
 *
 * 作用：
 *   1. 清洗：剔除剩余流量/到期时间/官网等无效节点，按名称去重
 *   2. 分类：按地区拆分节点，生成各地区 url-test 自动选择组
 *   3. 兜底：未匹配地区的节点归入「🌐 其他地区」；规则中失效的策略组名重定向到「🚀 节点选择」
 *   4. 直连：在 MATCH 前补「国内域名/IP」「局域网域名/网段」直连规则（可用开关关闭）
 *   5. 优先：⚡ 优先节点 按 美国 → 日本 → 其他地区 的顺序自动切换
 *   6. AI：OpenAI/Claude/Gemini/Copilot 等域名走 🤖 AI 服务 组（内置域名规则 + GitHub 规则集），组内按纯净度排序
 *
 * 限制：只处理内联 proxies，订阅若使用 proxy-providers 需自行改造。
 * 调整方式：改文件顶部的常量（垃圾关键词、地区表、优先顺序、直连开关）即可，无需动实现部分。
 */

// ======== 可调参数 ========

// 无效节点关键词：命中即剔除
// 公告/套餐类：剩余、流量、到期…；提示类：建议、卡顿…；名称里带链接的一律当公告
// 注意别加「专线」——它是正常节点的质量标签（IPLC/IEPL 专线），
// 只有「请切换到专线节点」这种提示语才该被判为垃圾节点
var JUNK_PATTERN = /剩余|流量|到期|过期|重置|套餐|官网|订阅|购买|续费|客服|公告|网址|群组|邀请|注册|试用|优惠|折扣|建议|卡顿|切换|丢失|https?:\/\/|www\.|Traffic|Expire|Reset|Subscribe|Renew/i;

// 地区分组：自上而下匹配，命中第一个即归组；需要新地区时在这里追加一行
// 两字母国家码统一用 (^|[^A-Za-z])XX([^A-Za-z]|$) 约束，
// 避免 Russia→US、Ukraine→KR、Denmark→DE 这类子串误判
var REGIONS = [
  { name: "🇭🇰 香港",   pattern: /香港|港|HKG|Hong\s?Kong|(^|[^A-Za-z])HK([^A-Za-z]|$)/i },
  { name: "🇹🇼 台湾",   pattern: /台湾|台灣|台北|新北|彰化|Taiwan|(^|[^A-Za-z])TW([^A-Za-z]|$)/i },
  { name: "🇯🇵 日本",   pattern: /日本|东京|大阪|Japan|Tokyo|(^|[^A-Za-z])JP([^A-Za-z]|$)/i },
  { name: "🇰🇷 韩国",   pattern: /韩国|韓國|首尔|Korea|Seoul|(^|[^A-Za-z])KR([^A-Za-z]|$)/i },
  { name: "🇸🇬 新加坡", pattern: /新加坡|狮城|Singapore|SGP|(^|[^A-Za-z])SG([^A-Za-z]|$)/i },
  { name: "🇺🇸 美国",   pattern: /美国|洛杉矶|圣何塞|西雅图|硅谷|USA|America|United\s?States|(^|[^A-Za-z])US([^A-Za-z]|$)/i },
  { name: "🇬🇧 英国",   pattern: /英国|伦敦|Britain|England|(^|[^A-Za-z])UK([^A-Za-z]|$)/i },
  { name: "🇩🇪 德国",   pattern: /德国|法兰克福|Germany|Frankfurt|(^|[^A-Za-z])DE([^A-Za-z]|$)/i }
];

var ENTRY_GROUP    = "🚀 节点选择";
var PRIORITY_GROUP = "⚡ 优先节点";
var AUTO_GROUP     = "♻️ 自动选择";
var OTHER_GROUP    = "🌐 其他地区";
var DIRECT_GROUP   = "🎯 全球直连";

// 优先地区：按顺序放进「⚡ 优先节点」（fallback），前一个地区全部不可用才轮到下一个。
// 名字必须和 REGIONS 里的 name 完全一致（含 flag emoji），写错会被忽略并在日志里告警。
var PRIORITY = ["🇺🇸 美国", "🇯🇵 日本", "🇰🇷 韩国", "🇹🇼 台湾", "🇸🇬 新加坡"];

var TEST_URL  = "https://www.gstatic.com/generate_204";
var INTERVAL  = 300;
var TOLERANCE = 50;

// 直连策略：不需要时把对应开关设为 false，脚本就不碰这部分规则
var CN_DIRECT  = true;   // 国内流量直连
var LAN_DIRECT = true;   // 局域网/私有地址直连
var CN_GEOSITE = true;   // 用 GEOSITE,cn 覆盖国内域名（GeoSite.dat 由 FlClash 自带，无需下载）

// —— AI 分流（ChatGPT / Claude / Gemini / Copilot 等）——
// 脚本没有网络能力，无法真的去查 IP 风险分，这里只按节点名做纯净度启发式；
// 想用真实检测结果，把测出来的节点名填进下面的手工名单即可。
var AI_GROUP = "🤖 AI 服务";
var AI_ROUTE = true;   // 把 AI 相关域名固定路由到该组

// 规则集：MetaCubeX/meta-rules-dat 的 AI 聚合列表（category-ai-!cn，约 200 条），
// 覆盖 OpenAI/Claude/Gemini/Copilot/Perplexity/Grok/Midjourney/PoE/HuggingFace 等；
// 列表里没有的服务由下面 AI_EXTRA_RULES 补齐。下载走入口组，否则 GitHub raw 可能拉不到
var AI_PROVIDER_ENABLED = true;
var AI_PROVIDER_PROXY   = ENTRY_GROUP;   // 也可以改成 "🎯 全球直连"
var AI_PROVIDERS = [
  {
    name: "AI-All",
    url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ai-!cn.yaml",
    behavior: "domain",
    format: "yaml"
  }
];

// FlClash 自带的 GEOSITE.dat（4.4MB）里没有 category-ai-!cn，只有下面这些 AI 分类
// （逐个用 mihomo -t 验证过存在）。关掉规则集时用它们兜底，零网络依赖。
var AI_GEOSITE_FALLBACK = ["openai", "anthropic", "google-gemini", "perplexity", "huggingface", "poe", "cursor"];

// 允许跑 ChatGPT 的地区（用地区组名）；香港等不在名单里的地区不会被选中
var OPENAI_REGIONS = ["🇺🇸 美国", "🇯🇵 日本", "🇸🇬 新加坡", "🇰🇷 韩国", "🇹🇼 台湾", "🇬🇧 英国", "🇩🇪 德国"];

// 节点名里的正/负信号，按命中次数加减分
var PURE_PATTERN  = /家宽|商宽|独享|原生|解锁|ChatGPT|OpenAI|IPLC|IEPL|专线/gi;
var DIRTY_PATTERN = /免费|公益|公共|共享|万人|试用|测试|白嫖/gi;

// 手工校正：确认过 IP 纯净的节点名（+10 分）；不要给 AI 用的节点名（包含匹配，直接排除）
// CLEAN 列表的顺序就是组内顺序，按实测结果从好到差填写即可
var OPENAI_CLEAN_EXTRA = [];
var OPENAI_BLOCK_EXTRA = [];

// OpenAI 相关域名：内置兜底，规则集关掉时也能保证核心服务可用
var OPENAI_RULES = [
  "DOMAIN-SUFFIX,openai.com",
  "DOMAIN-SUFFIX,chatgpt.com",
  "DOMAIN-SUFFIX,oaistatic.com",
  "DOMAIN-SUFFIX,oaiusercontent.com",
  "DOMAIN-SUFFIX,sora.com",
  "DOMAIN-KEYWORD,openai",
  "DOMAIN-KEYWORD,chatgpt"
];

// 聚合规则集里没有、但常用的 AI 服务，按需增删
var AI_EXTRA_RULES = [
  "DOMAIN-SUFFIX,suno.com",
  "DOMAIN-SUFFIX,suno.ai",
  "DOMAIN-SUFFIX,runwayml.com",
  "DOMAIN-SUFFIX,together.ai",
  "DOMAIN-SUFFIX,replicate.com",
  "DOMAIN-SUFFIX,lumalabs.ai",
  "DOMAIN-SUFFIX,recraft.ai",
  "DOMAIN-SUFFIX,thinkingmachines.ai"
];

// ======== 实现 ========

function main(config) {
  // 1. 清洗：剔除无效节点，并按名称去重（重名节点会导致配置校验失败）
  var seen = {};
  var cleaned = [];
  var proxies = Array.isArray(config.proxies) ? config.proxies : [];
  proxies.forEach(function (p) {
    if (!p || !p.name) return;
    if (JUNK_PATTERN.test(p.name)) return;
    if (seen[p.name]) return;
    seen[p.name] = true;
    cleaned.push(p);
  });
  // 全部是垃圾节点时原样返回：此时若先清空 proxies，原配置里的策略组会引用已不存在的节点而校验失败
  if (cleaned.length === 0) {
    log("[override] 没有可用的内联节点，跳过处理");
    return config;
  }
  config.proxies = cleaned;

  // 2. 分类：按地区装桶，未命中的进「其他地区」
  var buckets = REGIONS.map(function (r) {
    return { name: r.name, pattern: r.pattern, proxies: [] };
  });
  var others = [];
  cleaned.forEach(function (p) {
    var hit = null;
    for (var i = 0; i < buckets.length; i++) {
      if (buckets[i].pattern.test(p.name)) { hit = buckets[i]; break; }
    }
    if (hit) hit.proxies.push(p.name);
    else others.push(p.name);
  });

  var regionGroups = buckets
    .filter(function (b) { return b.proxies.length > 0; })
    .map(function (b) {
      return urlTestGroup(b.name, b.proxies);
    });

  if (others.length > 0) regionGroups.push(urlTestGroup(OTHER_GROUP, others));

  var regionNames = regionGroups.map(function (g) { return g.name; });

  // 3. 重建策略组
  // 优先组用 fallback：按列表顺序挑第一个可用成员，美国全挂才轮到日本，都没有才用其他地区
  var knownRegions = REGIONS.map(function (r) { return r.name; });
  var typo = PRIORITY.filter(function (n) {
    return knownRegions.indexOf(n) === -1;
  });
  if (typo.length > 0) {
    log("[override] PRIORITY 里这些名字不在 REGIONS 中，已忽略：" + typo.join("、"));
  }

  var priorityNames = PRIORITY.filter(function (n) {
    return regionNames.indexOf(n) !== -1;
  }).concat(regionNames.filter(function (n) {
    return PRIORITY.indexOf(n) === -1;
  }));

  var priorityGroup = {
    name: PRIORITY_GROUP,
    type: "fallback",
    proxies: priorityNames,
    url: TEST_URL,
    interval: INTERVAL
  };

  // ChatGPT 组：只收 OpenAI 支持地区的节点，按纯净度分数从高到低排，默认用第一个。
  // 用 select 而不是 url-test：同一会话固定一条线路，避免出口 IP 频繁跳变触发风控。
  var openaiCandidates = [];
  regionGroups.forEach(function (g) {
    if (OPENAI_REGIONS.indexOf(g.name) === -1) return;
    g.proxies.forEach(function (name) {
      if (!isBlockedForChatGPT(name)) openaiCandidates.push(name);
    });
  });
  if (openaiCandidates.length === 0) {
    cleaned.forEach(function (p) {
      if (!isBlockedForChatGPT(p.name)) openaiCandidates.push(p.name);
    });
    log("[override] 没有 OpenAI 支持地区的节点，ChatGPT 组退回全部节点");
  }
  openaiCandidates.sort(compareByPurity);

  var aiGroup = {
    name: AI_GROUP,
    type: "select",
    proxies: openaiCandidates.length > 0 ? openaiCandidates : [DIRECT_GROUP]
  };

  var groups = [{
    name: ENTRY_GROUP,
    type: "select",
    proxies: [PRIORITY_GROUP, AUTO_GROUP].concat(regionNames, [DIRECT_GROUP])
  }, priorityGroup, aiGroup, urlTestGroup(AUTO_GROUP, cleaned.map(function (p) { return p.name; }))]

    .concat(regionGroups, [{
      name: DIRECT_GROUP,
      type: "select",
      proxies: ["DIRECT"]
    }]);


  config["proxy-groups"] = groups;

  // 4. 修复规则：原规则引用的组已被重建替换，失效目标重定向到入口组，避免配置校验失败
  var validTargets = {};
  groups.forEach(function (g) { validTargets[g.name] = true; });
  cleaned.forEach(function (p) { validTargets[p.name] = true; });
  ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].forEach(function (n) {
    validTargets[n] = true;
  });

  var rules = Array.isArray(config.rules) ? config.rules : [];
  config.rules = rules.map(function (rule) {
    if (typeof rule !== "string") return rule;
    var parts = rule.split(",").map(function (s) { return s.trim(); });
    if (parts.length < 2) return rule;
    var idx = parts.length - 1;
    if (parts[idx] === "no-resolve" || parts[idx] === "src") idx -= 1; // 形如 IP-CIDR,x,DIRECT,no-resolve
    if (idx <= 0) return rule;
    if (!validTargets[parts[idx]]) {
      parts[idx] = ENTRY_GROUP;
      return parts.join(",");
    }
    return rule;
  });

  var hasMatch = config.rules.some(function (r) {
    return typeof r === "string" && /^MATCH/i.test(r);
  });
  if (!hasMatch) config.rules.push("MATCH," + ENTRY_GROUP);

  // 5. AI 分流：内置域名 + GitHub 规则集统一走 AI 组，放在 MATCH 前、GEOIP,CN 之前
  if (AI_PROVIDER_ENABLED) {
    // 合并进 rule-providers，订阅自带的条目保留；path 用相对路径，落在 mihomo 的 Home Dir
    var providers = (config["rule-providers"] && typeof config["rule-providers"] === "object")
      ? config["rule-providers"] : {};
    AI_PROVIDERS.forEach(function (ai) {
      providers[ai.name] = {
        type: "http",
        behavior: ai.behavior || "classical",
        format: ai.format || "yaml",
        url: ai.url,
        path: "./" + ai.name + ".yaml",
        interval: 86400,
        proxy: AI_PROVIDER_PROXY
      };
    });
    config["rule-providers"] = providers;
  }

  if (AI_ROUTE) {
    var managedAI = /^DOMAIN-(?:SUFFIX|KEYWORD)\s*,\s*(?:openai\.com|chatgpt\.com|oaistatic\.com|oaiusercontent\.com|sora\.com|openai|chatgpt)(?:\s*,|$)/i;
    var managedAISet = AI_PROVIDER_ENABLED
      ? /^RULE-SET\s*,\s*AI-[A-Za-z0-9]+(?:\s*,|$)/i
      : null;
    var managedAIGeosite = AI_PROVIDER_ENABLED
      ? null
      : /^GEOSITE\s*,\s*(?:openai|anthropic|google-gemini|perplexity|huggingface|poe|cursor)(?:\s*,|$)/i;

    config.rules = config.rules.filter(function (r) {
      if (typeof r !== "string") return true;
      if (managedAI.test(r)) return false;
      if (managedAISet && managedAISet.test(r)) return false;
      if (managedAIGeosite && managedAIGeosite.test(r)) return false;
      return true;
    });

    var aiRules = OPENAI_RULES.concat(AI_EXTRA_RULES).map(function (r) { return r + "," + AI_GROUP; });
    if (AI_PROVIDER_ENABLED) {
      AI_PROVIDERS.forEach(function (ai) {
        aiRules.push("RULE-SET," + ai.name + "," + AI_GROUP);
      });
    } else {
      AI_GEOSITE_FALLBACK.forEach(function (category) {
        aiRules.push("GEOSITE," + category + "," + AI_GROUP);
      });
    }
    insertRulesBeforeMatch(config.rules, aiRules);
  }

  // 6. 国内 / 局域网直连：域名规则在前、IP 规则在后，整块放在 MATCH 之前
  var directRules = [];

  if (CN_DIRECT) {
    // 只靠 GEOIP,CN 管不到域名：fake-ip 下域名流量不会走到 IP 规则
    if (CN_GEOSITE) directRules.push("GEOSITE,cn," + DIRECT_GROUP);
    directRules.push("DOMAIN-SUFFIX,cn," + DIRECT_GROUP);
  }

  if (LAN_DIRECT) {
    // 域名层：.local 走 mDNS、.lan 是常见的内网域名
    ["local", "lan", "home.arpa"].forEach(function (domain) {
      directRules.push("DOMAIN-SUFFIX," + domain + "," + DIRECT_GROUP);
    });
    // IPv4：回环、私有网段、CGNAT（Tailscale 等）、链路本地、组播、广播
    [
      "127.0.0.0/8",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "169.254.0.0/16",
      "224.0.0.0/4",
      "255.255.255.255/32"
    ].forEach(function (prefix) {
      directRules.push("IP-CIDR," + prefix + "," + DIRECT_GROUP + ",no-resolve");
    });
    // IPv6：回环、唯一本地地址、链路本地
    ["::1/128", "fc00::/7", "fe80::/10"].forEach(function (prefix) {
      directRules.push("IP-CIDR6," + prefix + "," + DIRECT_GROUP + ",no-resolve");
    });
  }

  if (CN_DIRECT) directRules.push("GEOIP,CN," + DIRECT_GROUP + ",no-resolve");

  if (directRules.length > 0) {
    // 原有的同类规则一律换成上面这一份，避免重复和顺序漂移
    var isManaged = function (r) {
      if (typeof r !== "string") return false;
      if (CN_DIRECT && /^GEOIP\s*,\s*CN(\s*,|$)/i.test(r)) return true;
      if (CN_DIRECT && CN_GEOSITE && /^GEOSITE\s*,\s*cn(\s*,|$)/i.test(r)) return true;
      if (CN_DIRECT && /^DOMAIN-SUFFIX\s*,\s*cn(\s*,|$)/i.test(r)) return true;
      if (LAN_DIRECT && /^DOMAIN-SUFFIX\s*,\s*(local|lan|home\.arpa)(\s*,|$)/i.test(r)) return true;
      if (LAN_DIRECT &&
          /^IP-CIDR6?\s*,\s*(127\.0\.0\.0\/8|10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16|100\.64\.0\.0\/10|169\.254\.0\.0\/16|224\.0\.0\.0\/4|255\.255\.255\.255\/32|::1\/128|fc00::\/7|fe80::\/10)(\s*,|$)/i.test(r)) {
        return true;
      }
      return false;
    };
    config.rules = config.rules.filter(function (r) { return !isManaged(r); });
    insertRulesBeforeMatch(config.rules, directRules);
  }

  log("[override] " + cleaned.length + " 个节点 → " + regionNames.length + " 个地区组");
  return config;
}

// 生成一个 url-test 自动选择组
function urlTestGroup(name, proxies) {
  return {
    name: name,
    type: "url-test",
    proxies: proxies,
    url: TEST_URL,
    interval: INTERVAL,
    tolerance: TOLERANCE
  };
}

// 节点名纯净度打分：正/负关键词按命中次数加减，手工名单额外加权
function purityScore(name) {
  var score = 0;
  var pure = name.match(PURE_PATTERN);
  if (pure) score += pure.length * 2;
  var dirty = name.match(DIRTY_PATTERN);
  if (dirty) score -= dirty.length * 4;
  if (OPENAI_CLEAN_EXTRA.indexOf(name) !== -1) score += 10;
  return score;
}

// 实测名单优先：CLEAN 列表里的节点按列表顺序排在前面，其余再按名称分数排
function compareByPurity(a, b) {
  var ai = OPENAI_CLEAN_EXTRA.indexOf(a);
  var bi = OPENAI_CLEAN_EXTRA.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  var diff = purityScore(b) - purityScore(a);
  if (diff !== 0) return diff;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBlockedForChatGPT(name) {
  return OPENAI_BLOCK_EXTRA.some(function (kw) {
    return kw && name.indexOf(kw) !== -1;
  });
}

// 把一组规则插到 MATCH 之前；没有 MATCH 时追加到末尾
function insertRulesBeforeMatch(rules, block) {
  for (var i = rules.length - 1; i >= 0; i--) {
    if (typeof rules[i] === "string" && /^MATCH\b/i.test(rules[i])) {
      rules.splice.apply(rules, [i, 0].concat(block));
      return;
    }
  }
  Array.prototype.push.apply(rules, block);
}


function log(msg) {
  if (typeof console !== "undefined" && console.log) console.log(msg);
}
