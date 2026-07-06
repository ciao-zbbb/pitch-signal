/**
 * 2026 世界杯 Dashboard - Pure Node.js (no dependencies)
 * 
 * 使用应用配置模块进行依赖注入和模块化管理
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createAppConfig } = require('./lib/app');
const { createLogger } = require('./lib/logger');

// 创建应用配置
const appConfig = createAppConfig();
const { PORT, DATA_DIR, ESPN_BASE, TEMPLATES, STATIC, infra, teamData, matchupModules, services, routes } = appConfig;

// 创建主日志记录器
const logger = createLogger('server');

// 从teamData获取常量
const { 
  TEAM_NAMES, 
  TEAM_FLAGS, 
  TEAM_LOGOS, 
  TEAM_NAMES_ZH, 
  ELO_RANK_MAP, 
  getTeamNameZh, 
  getTeamNameI18n, 
  resolveTeam, 
  getPlayerRatingData 
} = teamData;

// 从infra获取中间件
const { wrapCORS, parseBody, rateLimit } = infra;

// 路由匹配函数
function matchRoute(method, pathname) {
  for (const [key, handler] of Object.entries(routes)) {
    const [rMethod, rPath] = key.split(' ');
    if (rMethod !== method) continue;
    const rParts = rPath.split('/');
    const pParts = pathname.split('/');
    if (rParts.length !== pParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rParts.length; i++) {
      if (rParts[i].startsWith(':')) params[rParts[i].slice(1)] = decodeURIComponent(pParts[i]);
      else if (rParts[i] !== pParts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

// MIME类型映射
const MIME = {
  '.html': 'text/html', 
  '.css': 'text/css', 
  '.js': 'application/javascript',
  '.json': 'application/json', 
  '.png': 'image/png', 
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', 
  '.ico': 'image/x-icon', 
  '.webmanifest': 'application/manifest+json',
};

// 静态文件服务
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const base = path.basename(filePath);
  const cacheControl = ext === '.html' || ext === '.js' || ext === '.css' || base === 'sw.js'
    ? 'no-cache, must-revalidate'
    : 'public, max-age=3600';
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) { 
      res.writeHead(404); 
      res.end('Not found'); 
      return; 
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl });
    fs.createReadStream(filePath).pipe(res);
  });
}

// 安全的静态文件路径
function safeStaticPath(root, requestPath) {
  const safeRoot = path.resolve(root);
  const fullPath = path.resolve(safeRoot, requestPath);
  if (fullPath !== safeRoot && !fullPath.startsWith(safeRoot + path.sep)) return null;
  return fullPath;
}

// 功能开关验证
function assertFeatureGates() {
  const GATES = [
    { key: 'POLYMARKET_ENABLED', label: 'GATE-1 外部市场信号（Polymarket）融合' },
    { key: 'PUNDIT_ENABLED', label: 'GATE-2 专家观点聚合（Pundit）' },
    { key: 'AUTO_CALIBRATION', label: 'GATE-3 模型自动校准' },
  ];
  
  for (const { key, label } of GATES) {
    if (process.env[key] === 'true') {
      logger.warn(`⛔ [${label}] ${key}=true 被检测到 — 强制覆盖为 false（公测 Beta 阶段禁止启用）`);
      process.env[key] = 'false';
    } else {
      process.env[key] = 'false';
      logger.info(`✅ [${label}] ${key}=false 已确认`);
    }
  }
  
  logger.info('✅ [GATE-4] AI 仅生成赛后文字复盘，不修改任何预测概率');
}

// 执行功能开关验证
assertFeatureGates();

// HTTP服务器
let shuttingDown = false;
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  
  // 请求完成时记录日志
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${pathname} ${res.statusCode} ${duration}ms`, {
      clientIp,
      method: req.method,
      pathname,
      statusCode: res.statusCode,
      duration,
    });
  });
  
  // CORS处理
  if (wrapCORS(req, res)) return;
  
  // 限流处理
  if (pathname.startsWith('/api/') && rateLimit(req, res)) return;
  
  // 解析请求体
  let body;
  try { 
    body = await parseBody(req); 
  }
  catch (e) {
    logger.warn('Body parse failed', { error: e.message || e });
    res.writeHead(e.statusCode || 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }
  
  // 路由匹配
  const route = matchRoute(req.method, pathname);
  if (route) {
    try {
      const mergedParams = { ...Object.fromEntries(parsed.searchParams.entries()), ...route.params };
      const data = await route.handler(mergedParams, body, req);
      if (data && data.error && (data.statusCode || data.code)) {
        res.writeHead(data.statusCode || data.code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: data.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      logger.error('Route handler internal error', { error: e.message || e });
      const statusCode = e.statusCode || 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(e.payload || { error: 'Internal server error' }));
    }
    return;
  }
  
  // 静态文件处理
  if (pathname.startsWith('/static/')) {
    let requestedFile;
    try { 
      requestedFile = decodeURIComponent(pathname.slice(8)); 
    }
    catch { 
      res.writeHead(400); 
      res.end('Bad request'); 
      return; 
    }
    const filePath = safeStaticPath(STATIC, requestedFile);
    if (!filePath) { 
      res.writeHead(403); 
      res.end('Forbidden'); 
      return; 
    }
    return serveStatic(res, filePath);
  }
  
  // PWA manifest
  if (pathname.startsWith('/manifest.json')) {
    return serveStatic(res, path.join(STATIC, 'manifest.json'));
  }

  // Serve the worker from the origin root so it can control the app at `/`.
  if (pathname === '/sw.js') {
    return serveStatic(res, path.join(STATIC, 'sw.js'));
  }
  
  // 默认页面
  serveStatic(res, path.join(TEMPLATES, 'index.html'));
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`⚽ PitchSignal: http://0.0.0.0:${PORT}`);

  // 确保赛程表已播种：P0-3 终场比分回写 / P4-4 校准报告 / P3-1 Track-B 都依赖
  // matches 表有真实赛程。此前 seedRealGroups 虽定义却从未被调用，导致该表为空、
  // 相关功能静默失效。此处启动时幂等补种（已有数据则跳过）。
  try {
    const { groups } = require('./lib/db');
    const seeded = groups.seedRealGroups();
    if (seeded > 0) logger.info(`[boot] 已播种 ${seeded} 个小组赛程到 matches 表`);
  } catch (e) {
    logger.warn('[boot] 赛程播种失败', { error: e.message });
  }

  // 启动后台任务
  try {
    const { startJobs } = require('./lib/jobs');
    startJobs({ 
      db: require('./lib/db').db, 
      predictionService: services.predictionService, 
      reviewService: services.reviewService, 
      dataDir: DATA_DIR 
    });
  } catch (e) {
    logger.warn('Background jobs unavailable', { error: e.message });
  }
});

// 优雅关闭
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  
  logger.info(`Received ${signal}; shutting down gracefully...`);
  
  // 停止后台任务
  try {
    const { stopJobs } = require('./lib/jobs');
    stopJobs();
  } catch (e) {
    logger.warn('Failed to stop background jobs', { error: e.message });
  }
  
  // 强制退出超时
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  
  // 关闭服务器
  server.close((error) => {
    try {
      require('./lib/db').db.close();
    } catch (dbError) {
      logger.warn(`Database close skipped: ${dbError.message}`);
    }
    
    clearTimeout(forceExit);
    process.exit(error ? 1 : 0);
  });
}

// 注册信号处理
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
