export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 处理后台增删改 API 请求
    if (url.pathname.startsWith('/api/admin/')) {
      return handleAdminApi(request, env);
    }

    // 2. 获取根域名与子域名
    const rootDomain = getRootDomain(url.hostname, env);
    const hostname = url.hostname.toLowerCase();

    let subdomain = '';
    if (hostname !== rootDomain && hostname.endsWith('.' + rootDomain)) {
      subdomain = hostname.slice(0, -(rootDomain.length + 1));
    }

    // 3. 从 D1 读取所有路由
    let routes;
    try {
      routes = await getAllRoutes(env);
    } catch (error) {
      if (isRouteSchemaMigrationError(error)) {
        return new Response(ROUTES_SCHEMA_MIGRATION_ERROR, {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        });
      }
      throw error;
    }
    const matchedRoute = routes.find(
      (r) => r.subdomain.toLowerCase() === subdomain
    );

    // 4. 未匹配到记录时，展示管理导航面板
    if (!matchedRoute) {
      return renderDashboard(routes, rootDomain, !!(env.ADMIN_PASSWORD || 'afwhuiafh'), env);
    }

    // 更具体的 Cloudflare Worker Route 应直接命中目标 Worker；若请求仍到达 luyou，说明 Route 未生效。
    if (Number(matchedRoute.enabled) === 2) {
      return new Response('Cloudflare Worker Route 未生效，请检查该子域名对应的 Route 配置。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      });
    }

    // 5. 目标 URL 规范化
    const targetUrl = new URL(
      /^https?:\/\//i.test(matchedRoute.target_url)
        ? matchedRoute.target_url
        : `https://${matchedRoute.target_url}`
    );

    const basePath = targetUrl.pathname.replace(/\/+$/, '');
    const requestPath = url.pathname.replace(/^\/+/, '');
    targetUrl.pathname = requestPath ? `${basePath}/${requestPath}` : `${basePath || '/'}`;
    targetUrl.search = url.search;

    // 6. 直连模式 (302 重定向)
    if (matchedRoute.enabled === 0) {
      return Response.redirect(targetUrl.toString(), 302);
    }

    // 7. 反代模式
    const newHeaders = new Headers(request.headers);
    newHeaders.set('Host', targetUrl.hostname);

    const proxyRequestInit = {
      method: request.method,
      headers: newHeaders,
      redirect: 'follow',
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      proxyRequestInit.body = request.body;
    }

    try {
      return await fetch(new Request(targetUrl.toString(), proxyRequestInit));
    } catch (error) {
      return new Response(`反向代理请求失败: ${error.message}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      });
    }
  },
};

// ---------------- API 增删改接口 ----------------
async function handleAdminApi(request, env) {
  if (!env.DB) {
    return jsonResponse({ error: '未检测到 D1 数据库绑定' }, 500);
  }

  const adminPassword = env.ADMIN_PASSWORD || 'afwhuiafh';
  const authHeader = request.headers.get('x-admin-password') || '';
  if (authHeader !== adminPassword) {
    return jsonResponse({ error: '管理密码错误，无权操作！' }, 403);
  }

  const url = new URL(request.url);
  const action = url.pathname.replace('/api/admin/', '');

  if (action === 'verify') {
    return jsonResponse({ success: true, message: '鉴权成功！' });
  }

  try {
    const body = await request.json();

    if (action === 'save') {
      const { id, subdomain, target_url, navigation_path, title, category, tags, enabled } = body;
      const mode = enabled !== undefined ? Number(enabled) : 1;
      const isProxy = mode === 1;
      const routeTargetInput = String(target_url || '').trim();
      const routeNavigationPath = String(navigation_path || '').trim();
      let routeSubdomain = String(subdomain || '').trim().toLowerCase();
      if (!target_url) {
        return jsonResponse({ error: '目标地址不能为空' }, 400);
      }
      if (![0, 1, 2].includes(mode)) {
        return jsonResponse({ error: '访问模式无效' }, 400);
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(routeNavigationPath) || routeNavigationPath.startsWith('//')) {
        return jsonResponse({ error: '跳转路径必须是站内路径' }, 400);
      }
      if (mode !== 0 && !routeSubdomain) {
        return jsonResponse({ error: '子域名前缀不能为空' }, 400);
      }
      if (mode === 2 && !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(routeTargetInput)) {
        return jsonResponse({ error: 'Worker Route 模式请填写有效的 Worker 名称' }, 400);
      }
      if (mode === 2 && !isValidSubdomain(routeSubdomain)) {
        return jsonResponse({ error: '子域名前缀格式无效，Worker Route 仅支持有效的域名标签' }, 400);
      }
      const normalizedTarget = mode === 2 ? routeTargetInput : normalizeTargetUrl(routeTargetInput);
      const rootDomain = getRootDomain(new URL(request.url).hostname, env);
      if (id) {
        const previousRoute = await env.DB.prepare(
          'SELECT id, subdomain, target_url, enabled FROM routes WHERE id = ?1'
        ).bind(Number(id)).first();
        if (!previousRoute) {
          return jsonResponse({ error: '服务不存在，请刷新页面后重试' }, 404);
        }
        if (mode === 0 && !routeSubdomain) {
          routeSubdomain = previousRoute.subdomain;
        }
        const existing = await env.DB.prepare(
          'SELECT id FROM routes WHERE subdomain = ?1 AND id != ?2'
        ).bind(routeSubdomain, Number(id)).first();
        if (existing) {
          return jsonResponse({ error: `子域名 "${routeSubdomain}" 已被其他服务使用！` }, 400);
        }

        const routeRollback = await syncCloudflareRoute(
          env,
          rootDomain,
          cloudflareRouteFor(previousRoute),
          mode === 2 ? { subdomain: routeSubdomain, script: normalizedTarget } : null
        );
        try {
          await env.DB.prepare(
            `UPDATE routes 
             SET subdomain = ?1, target_url = ?2, navigation_path = ?3, title = ?4, enabled = ?5, category = ?6, tags = ?7 
             WHERE id = ?8`
          ).bind(
            routeSubdomain,
            normalizedTarget,
            routeNavigationPath,
            title?.trim() || (mode === 2 ? 'Worker 路由服务' : isProxy ? '反代服务' : '直连服务'),
            mode,
            category?.trim() || '',
            normalizeTags(tags).join(', '),
            Number(id)
          ).run();
        } catch (error) {
          await routeRollback();
          throw error;
        }

        return jsonResponse({ success: true, message: '更新成功！' });
      }

      if (mode === 0 && !routeSubdomain) {
        routeSubdomain = `direct-${crypto.randomUUID()}`;
      }
      const existing = await env.DB.prepare(
        'SELECT id FROM routes WHERE subdomain = ?1'
      ).bind(routeSubdomain).first();
      if (existing) {
        return jsonResponse({ error: `子域名 "${routeSubdomain}" 已存在！` }, 400);
      }

      // 新卡片追加到排序末尾；历史空排序值会先补齐，避免插入到旧卡片前面。
      await initializeRouteSortOrders(env);
      const nextSortOrderRow = await env.DB.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM routes'
      ).first();
      const nextSortOrder = Number(nextSortOrderRow?.next_sort_order ?? 0);

      const routeRollback = await syncCloudflareRoute(
        env,
        rootDomain,
        null,
        mode === 2 ? { subdomain: routeSubdomain, script: normalizedTarget } : null
      );
      try {
        await env.DB.prepare(
          `INSERT INTO routes (subdomain, target_url, navigation_path, title, enabled, category, tags, sort_order) 
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(
          routeSubdomain,
          normalizedTarget,
          routeNavigationPath,
          title?.trim() || (mode === 2 ? 'Worker 路由服务' : isProxy ? '反代服务' : '直连服务'),
          mode,
          category?.trim() || '',
          normalizeTags(tags).join(', '),
          nextSortOrder
        ).run();
      } catch (error) {
        await routeRollback();
        throw error;
      }

      return jsonResponse({ success: true, message: '保存成功！' });
    }

    if (action === 'reorder') {
      const { ids, subdomains } = body;
      if (!Array.isArray(ids) && !Array.isArray(subdomains)) {
        return jsonResponse({ error: '排序数据格式错误' }, 400);
      }

      if (Array.isArray(ids)) {
        const orderedIds = ids.map(Number).filter((id) => Number.isInteger(id) && id > 0);
        if (
          orderedIds.length !== ids.length ||
          new Set(orderedIds).size !== orderedIds.length
        ) {
          return jsonResponse({ error: '排序数据包含无效或重复的服务 ID' }, 400);
        }

        const { results: currentRoutes = [] } = await env.DB.prepare(
          'SELECT id FROM routes'
        ).all();
        const currentIds = new Set(currentRoutes.map((route) => Number(route.id)));
        if (
          currentIds.size !== orderedIds.length ||
          orderedIds.some((id) => !currentIds.has(id))
        ) {
          return jsonResponse({ error: '服务列表已变更，请刷新页面后重新排序' }, 409);
        }

        await initializeRouteSortOrders(env);
        if (orderedIds.length) {
          await env.DB.batch(
            orderedIds.map((id, sortOrder) =>
              env.DB.prepare(
                'UPDATE routes SET sort_order = ?1 WHERE id = ?2'
              ).bind(sortOrder, id)
            )
          );
        }

        return jsonResponse({ success: true, message: '排序已保存！' });
      }

      const orderedSubdomains = subdomains.map((subdomain) =>
        String(subdomain || '').trim().toLowerCase()
      );
      if (
        orderedSubdomains.some((subdomain) => !subdomain) ||
        new Set(orderedSubdomains).size !== orderedSubdomains.length
      ) {
        return jsonResponse({ error: '排序数据包含无效或重复的服务' }, 400);
      }

      const { results: currentRoutes = [] } = await env.DB.prepare(
        'SELECT subdomain FROM routes'
      ).all();
      const currentSubdomains = new Set(
        currentRoutes.map((route) => String(route.subdomain).toLowerCase())
      );
      if (
        currentSubdomains.size !== orderedSubdomains.length ||
        orderedSubdomains.some((subdomain) => !currentSubdomains.has(subdomain))
      ) {
        return jsonResponse({ error: '服务列表已变更，请刷新页面后重新排序' }, 409);
      }

      await initializeRouteSortOrders(env);
      if (orderedSubdomains.length) {
        await env.DB.batch(
          orderedSubdomains.map((subdomain, sortOrder) =>
            env.DB.prepare(
              'UPDATE routes SET sort_order = ?1 WHERE subdomain = ?2'
            ).bind(sortOrder, subdomain)
          )
        );
      }

      return jsonResponse({ success: true, message: '排序已保存！' });
    }

    if (action === 'delete') {
      const { id, subdomain } = body;
      const rootDomain = getRootDomain(new URL(request.url).hostname, env);
      if (id !== undefined && id !== null && id !== '') {
        const route = await env.DB.prepare(
          'SELECT id, subdomain, target_url, enabled FROM routes WHERE id = ?1'
        ).bind(Number(id)).first();
        const routeRollback = await syncCloudflareRoute(
          env,
          rootDomain,
          cloudflareRouteFor(route),
          null
        );
        try {
          await env.DB.prepare('DELETE FROM routes WHERE id = ?1')
            .bind(Number(id))
            .run();
        } catch (error) {
          await routeRollback();
          throw error;
        }
        return jsonResponse({ success: true, message: '删除成功！' });
      }
      if (subdomain) {
        const normalizedSubdomain = subdomain.trim().toLowerCase();
        const route = await env.DB.prepare(
          'SELECT id, subdomain, target_url, enabled FROM routes WHERE subdomain = ?1'
        ).bind(normalizedSubdomain).first();
        const routeRollback = await syncCloudflareRoute(
          env,
          rootDomain,
          cloudflareRouteFor(route),
          null
        );
        try {
          await env.DB.prepare('DELETE FROM routes WHERE subdomain = ?1')
            .bind(normalizedSubdomain)
            .run();
        } catch (error) {
          await routeRollback();
          throw error;
        }
        return jsonResponse({ success: true, message: '删除成功！' });
      }
      return jsonResponse({ error: '参数缺失' }, 400);
    }

    return jsonResponse({ error: '未知操作' }, 404);
  } catch (err) {
    if (isRouteSchemaMigrationError(err)) {
      return jsonResponse({ error: ROUTES_SCHEMA_MIGRATION_ERROR }, 503);
    }
    if (isMissingSortOrderColumn(err)) {
      return jsonResponse({ error: SORT_ORDER_MIGRATION_ERROR }, 400);
    }
    return jsonResponse({ error: err.message }, err.status || 500);
  }
}

const SORT_ORDER_MIGRATION_ERROR =
  '自定义排序尚未初始化，请先在 D1 执行：ALTER TABLE routes ADD COLUMN sort_order INTEGER;';
const ROUTES_SCHEMA_MIGRATION_ERROR =
  'routes 表结构需要迁移：请先执行项目中的 yhx/routes_migration.sql，为现有数据增加 id 主键并将 subdomain 设为必填；并执行 ALTER TABLE routes ADD COLUMN navigation_path TEXT NOT NULL DEFAULT \'\';';

function isMissingSortOrderColumn(error) {
  return /no such column:\s*sort_order/i.test(String(error?.message || error));
}

function isMissingNavigationPathColumn(error) {
  return /no such column:\s*navigation_path/i.test(String(error?.message || error));
}

function isMissingRouteIdColumn(error) {
  return /no such column:\s*id/i.test(String(error?.message || error));
}

function isRouteSchemaMigrationError(error) {
  return isMissingRouteIdColumn(error) ||
    isMissingNavigationPathColumn(error) ||
    String(error?.message || error) === ROUTES_SCHEMA_MIGRATION_ERROR;
}

function appendNavigationPath(baseUrl, navigationPath) {
  const relativePath = String(navigationPath || '').trim().replace(/^\/+/, '');
  if (!relativePath) return baseUrl;

  const base = new URL(baseUrl);
  const preservedSearch = base.search;
  const preservedHash = base.hash;
  base.search = '';
  base.hash = '';
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';

  const navigationUrl = new URL(relativePath, base);
  if (!/[?#]/.test(relativePath)) {
    navigationUrl.search = preservedSearch;
    navigationUrl.hash = preservedHash;
  }
  return navigationUrl.toString();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}

function isValidSubdomain(subdomain) {
  return subdomain.length <= 253 && subdomain.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

function cloudflareRouteFor(route) {
  return route && Number(route.enabled) === 2
    ? { subdomain: route.subdomain, script: route.target_url }
    : null;
}

function cloudflareRoutePattern(route, rootDomain) {
  return `${route.subdomain}.${rootDomain}/*`;
}

async function cloudflareApiRequest(env, path, options = {}) {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw Object.assign(
      new Error('Worker Route 模式需要配置 CF_API_TOKEN 和 CF_ZONE_ID'),
      { status: 503 }
    );
  }

  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw Object.assign(new Error(`Cloudflare API 请求失败: ${error.message}`), { status: 502 });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error(`Cloudflare API 返回无效响应（HTTP ${response.status}）`), { status: 502 });
  }
  if (!response.ok || !payload.success) {
    const details = (payload.errors || []).map((error) => error.message).filter(Boolean).join('；');
    throw Object.assign(
      new Error(`Cloudflare API 操作失败${details ? `：${details}` : `（HTTP ${response.status}）`}`),
      { status: response.status === 409 ? 409 : 502 }
    );
  }
  return payload;
}

async function listCloudflareRoutes(env) {
  const zoneId = encodeURIComponent(env.CF_ZONE_ID);
  const routes = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await cloudflareApiRequest(
      env,
      `/zones/${zoneId}/workers/routes?page=${page}&per_page=1000`
    );
    routes.push(...(payload.result || []));
    totalPages = Number(payload.result_info?.total_pages || 1);
    page += 1;
  } while (page <= totalPages);
  return routes;
}

async function findCloudflareRoute(env, pattern) {
  const routes = await listCloudflareRoutes(env);
  return routes.find((route) => route.pattern === pattern) || null;
}

async function createCloudflareRoute(env, pattern, script) {
  const payload = await cloudflareApiRequest(
    env,
    `/zones/${encodeURIComponent(env.CF_ZONE_ID)}/workers/routes`,
    { method: 'POST', body: JSON.stringify({ pattern, script }) }
  );
  return payload.result;
}

async function updateCloudflareRoute(env, routeId, pattern, script) {
  return cloudflareApiRequest(
    env,
    `/zones/${encodeURIComponent(env.CF_ZONE_ID)}/workers/routes/${encodeURIComponent(routeId)}`,
    { method: 'PUT', body: JSON.stringify({ pattern, script }) }
  );
}

async function deleteCloudflareRoute(env, routeId) {
  return cloudflareApiRequest(
    env,
    `/zones/${encodeURIComponent(env.CF_ZONE_ID)}/workers/routes/${encodeURIComponent(routeId)}`,
    { method: 'DELETE' }
  );
}

/**
 * 同步 D1 路由对应的 Cloudflare Route。返回的回滚函数用于 D1 写入失败时恢复原配置。
 */
async function syncCloudflareRoute(env, rootDomain, previous, next) {
  if (!previous && !next) return async () => {};

  const previousPattern = previous ? cloudflareRoutePattern(previous, rootDomain) : '';
  const nextPattern = next ? cloudflareRoutePattern(next, rootDomain) : '';

  if (previous && next && previousPattern === nextPattern) {
    const existingRoute = await findCloudflareRoute(env, previousPattern);
    if (existingRoute && existingRoute.script !== previous.script) {
      throw Object.assign(
        new Error(`Cloudflare Route ${previousPattern} 已被修改，拒绝覆盖`),
        { status: 409 }
      );
    }
    if (existingRoute && existingRoute.script === next.script) return async () => {};

    if (existingRoute) {
      await updateCloudflareRoute(env, existingRoute.id, nextPattern, next.script);
      return async () => {
        const currentRoute = await findCloudflareRoute(env, nextPattern);
        if (currentRoute?.script === next.script) {
          await updateCloudflareRoute(env, currentRoute.id, previousPattern, previous.script);
        }
      };
    }

    const createdRoute = await createCloudflareRoute(env, nextPattern, next.script);
    return async () => {
      if (createdRoute?.id) await deleteCloudflareRoute(env, createdRoute.id);
    };
  }

  let removedRoute = null;
  let createdRoute = null;
  try {
    if (previous) {
      const existingRoute = await findCloudflareRoute(env, previousPattern);
      if (existingRoute) {
        if (existingRoute.script !== previous.script) {
          throw Object.assign(
            new Error(`Cloudflare Route ${previousPattern} 已被修改，拒绝删除`),
            { status: 409 }
          );
        }
        await deleteCloudflareRoute(env, existingRoute.id);
        removedRoute = existingRoute;
      }
    }

    if (next) {
      const existingRoute = await findCloudflareRoute(env, nextPattern);
      if (existingRoute) {
        throw Object.assign(
          new Error(`Cloudflare Route ${nextPattern} 已存在，请先检查 Cloudflare 配置`),
          { status: 409 }
        );
      }
      createdRoute = await createCloudflareRoute(env, nextPattern, next.script);
    }
  } catch (error) {
    if (removedRoute) {
      try {
        await createCloudflareRoute(env, previousPattern, previous.script);
      } catch (rollbackError) {
        console.error('恢复原 Cloudflare Route 失败:', rollbackError);
      }
    }
    throw error;
  }

  return async () => {
    if (createdRoute?.id) await deleteCloudflareRoute(env, createdRoute.id);
    if (removedRoute) await createCloudflareRoute(env, previousPattern, previous.script);
  };
}

// ---------------- 数据库读取 ----------------
async function getAllRoutes(env) {
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT id, subdomain, target_url, navigation_path, title, enabled, category, tags, sort_order
         FROM routes
         ORDER BY
           CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,
           sort_order ASC,
           id ASC`
      ).all();
      if (results) return results;
    } catch (e) {
      if (isMissingSortOrderColumn(e)) {
        try {
          const { results } = await env.DB.prepare(
            'SELECT id, subdomain, target_url, navigation_path, title, enabled, category, tags FROM routes ORDER BY id ASC'
          ).all();
          if (results) return results;
        } catch (fallbackError) {
          if (isMissingRouteIdColumn(fallbackError)) {
            throw new Error(ROUTES_SCHEMA_MIGRATION_ERROR);
          }
          if (isMissingNavigationPathColumn(fallbackError)) {
            throw new Error(ROUTES_SCHEMA_MIGRATION_ERROR);
          }
          console.error('D1 兼容查询出错:', fallbackError);
        }
      }
      if (isMissingRouteIdColumn(e)) {
        throw new Error(ROUTES_SCHEMA_MIGRATION_ERROR);
      }
      if (isMissingNavigationPathColumn(e)) {
        throw new Error(ROUTES_SCHEMA_MIGRATION_ERROR);
      }
      console.error('D1 查询出错:', e);
    }
  }
  return [];
}

/**
 * 将尚未排序的历史服务追加到现有顺序末尾，保留已保存的手动排序。
 */
async function initializeRouteSortOrders(env) {
  const { results: unorderedRoutes = [] } = await env.DB.prepare(
    'SELECT id, subdomain FROM routes WHERE sort_order IS NULL ORDER BY id ASC'
  ).all();
  if (!unorderedRoutes.length) return;

  const nextSortOrderRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM routes'
  ).first();
  const firstSortOrder = Number(nextSortOrderRow?.next_sort_order ?? 0);

  await env.DB.batch(
    unorderedRoutes.map((route, index) =>
      env.DB.prepare(
        route.id !== undefined && route.id !== null
          ? 'UPDATE routes SET sort_order = ?1 WHERE id = ?2 AND sort_order IS NULL'
          : 'UPDATE routes SET sort_order = ?1 WHERE subdomain = ?2 AND sort_order IS NULL'
      ).bind(firstSortOrder + index, route.id ?? route.subdomain)
    )
  );
}

/**
 * 解析应用根域；workers.dev 地址需保留账号子域，避免把 Worker 名称并入错误的子域。
 */
function getRootDomain(hostname, env) {
  const envDomain = env?.ROOT_DOMAIN || env?.MAIN_DOMAIN || env?.DOMAIN;
  if (envDomain) {
    return envDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  const normalizedHostname = hostname.toLowerCase();
  const parts = normalizedHostname.split('.');
  if (normalizedHostname.endsWith('.workers.dev')) {
    return parts.length > 3 ? parts.slice(-3).join('.') : normalizedHostname;
  }

  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

function normalizeTargetUrl(value) {
  let targetUrl = String(value || '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://${targetUrl}`;
  }
  return targetUrl.replace(/\/+$/, "");
}

function normalizeTags(value) {
  return [...new Set(
    String(value || '')
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
  )];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function normalizeBackground(value, fallback) {
  const background = String(value || '').trim();
  if (/^(?:#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([^\n;{}]+\)|[a-zA-Z]+)$/.test(background)) {
    return { color: background, image: 'none' };
  }

  const markdownUrl = background.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i)?.[1];
  const imageUrl = markdownUrl || background;
  try {
    const parsedUrl = new URL(imageUrl);
    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      const safeUrl = parsedUrl.toString().replace(/["\\\r\n]/g, '\\$&');
      return { color: fallback, image: `url("${safeUrl}")`, url: parsedUrl.toString() };
    }
  } catch {
    // 非法背景值使用默认颜色，避免破坏页面样式。
  }

  return { color: fallback, image: 'none', url: '' };
}

// ---------------- 渲染页面 ----------------
function renderDashboard(routes, baseDomain, needPassword, env = {}) {
  const lightBackground = normalizeBackground(env.BG_LIGHT, '#f8fafc');
  const darkBackground = normalizeBackground(env.BG_DARK, '#0b1329');
  const categories = [...new Set(routes.map((route) => route.category?.trim()).filter(Boolean))].sort();
  const tags = [...new Set(routes.flatMap((route) => normalizeTags(route.tags)))].sort();
  const backgroundPreloads = [...new Set([lightBackground.url, darkBackground.url].filter(Boolean))]
    .map((url) => `<link rel="preload" as="image" href="${escapeHtml(url)}" fetchpriority="high">`)
    .join('\n  ');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(baseDomain)} - 服务管理面板</title>
  ${backgroundPreloads}
  <script>
    document.documentElement.dataset.theme = localStorage.getItem('route_theme') === 'dark' ? 'dark' : 'light';
    document.documentElement.classList.toggle('simple-view', localStorage.getItem('route_simple_view') !== '0');
    if (localStorage.getItem('admin_mode') === '1' && (!${needPassword} || !!localStorage.getItem('admin_pwd'))) {
      document.documentElement.classList.add('admin-mode');
    }
  </script>
  <style>
    :root {
      --bg-dark-color: ${darkBackground.color};
      --bg-dark-image: ${darkBackground.image};
      --bg-light-color: ${lightBackground.color};
      --bg-light-image: ${lightBackground.image};
      --bg-color: var(--bg-dark-color);
      --bg-image: var(--bg-dark-image);
      --card-bg: rgba(15, 23, 42, 0.78);
      --route-card-bg: rgba(15, 23, 42, 0.52);
      --text: #ffffff;
      --text-muted: #cbd5e1;
      --text-soft: #94a3b8;
      --label: #cbd5e1;
      --target: #ffffff;
      --action: #cbd5e1;
      --primary: #38bdf8;
      --primary-hover: #7dd3fc;
      --danger: #f87171;
      --success: #34d399;
      --direct: #c084fc;
      --category: #fde047;
      --category-bg: rgba(234, 179, 8, 0.22);
      --category-border: rgba(250, 204, 21, 0.55);
      --tag-text: #6ee7b7;
      --tag-bg: rgba(16, 185, 129, 0.22);
      --tag-border: rgba(52, 211, 153, 0.55);
      --border: rgba(148, 163, 184, 0.35);
      --input-bg: #0f172a;
      --button-text: #ffffff;
      --secondary-bg: #1e293b;
      --secondary-text: #f8fafc;
      --card-shadow: 0 10px 30px rgba(0, 0, 0, 0.42);
      --text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
    }
    :root[data-theme="light"] {
      --bg-color: var(--bg-light-color);
      --bg-image: var(--bg-light-image);
      --card-bg: rgba(255, 255, 255, 0.88);
      --route-card-bg: rgba(255, 255, 255, 0.72);
      --text: #0f172a;
      --text-muted: #334155;
      --text-soft: #475569;
      --label: #334155;
      --target: #000000;
      --action: #334155;
      --primary: #0284c7;
      --primary-hover: #0369a1;
      --danger: #dc2626;
      --success: #059669;
      --direct: #7c3aed;
      --category: #92400e;
      --category-bg: #fef3c7;
      --category-border: #f59e0b;
      --tag-text: #065f46;
      --tag-bg: #d1fae5;
      --tag-border: #10b981;
      --border: rgba(148, 163, 184, 0.55);
      --input-bg: #ffffff;
      --button-text: #ffffff;
      --secondary-bg: #e2e8f0;
      --secondary-text: #0f172a;
      --card-shadow: 0 10px 30px rgba(15, 23, 42, 0.14);
      --text-shadow: none;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scrollbar-gutter: stable; }
    input::placeholder {
      color: var(--text-soft);
      opacity: 1;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg-color);
      background-image: var(--bg-image);
      background-position: center;
      background-size: cover;
      background-attachment: fixed;
      background-repeat: no-repeat;
      color: var(--text);
      min-height: 100vh;
      padding: 310px 16px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    .container { 
      max-width: 1596px; 
      width: 100%; 
    }
    
    .filters {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 16px;
    }
    .filter-header-row {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .filter-options { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 5px; min-width: 0; }
    #tag-filter { width: 100%; }
    .toolbar-right {
      position: fixed;
      top: calc(50% - 138px);
      right: 20px;
      z-index: 998;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }
    .filter-chip {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 700;
      line-height: 1.2;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-chip:hover { border-color: var(--primary); color: var(--primary); }
    .filter-chip.active {
      background: var(--primary);
      border-color: var(--primary);
      color: var(--button-text);
      font-weight: 700;
    }
    .filter-clear {
      margin-left: 4em;
      font-weight: 700;
    }
    @media (max-width: 700px) {
      .filter-clear { margin-left: 0; }
    }
    .filter-select, .theme-toggle {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 9px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .theme-toggle:hover, .filter-select:focus { border-color: var(--primary); }
    .theme-toggle { white-space: nowrap; }
    .theme-toggle-btn {
      position: fixed;
      right: 20px;
      top: 50%;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.75);
      border: 1.5px solid #a3e635;
      color: #a3e635;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 12px rgba(163, 230, 53, 0.25);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: transform 0.2s ease, border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease;
      z-index: 999;
      user-select: none;
      padding: 0;
      line-height: 1;
    }
    .display-mode-toggle {
      top: calc(50% + 58px);
      font-size: 13px;
      font-weight: 700;
    }
    .add-service-toggle {
      top: calc(50% - 50px);
      font-size: 26px;
      font-weight: 800;
    }
    .theme-toggle-btn:hover {
      border-color: #bef264;
      color: #bef264;
      transform: translateY(-50%) scale(1.1);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 18px rgba(190, 242, 100, 0.45);
    }
    .theme-toggle-btn:active {
      transform: translateY(-50%) scale(0.95);
    }
    :root[data-theme="light"] .theme-toggle-btn {
      background: rgba(15, 23, 42, 0.85);
      border: 1.5px solid #facc15;
      color: #facc15;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 0 10px rgba(250, 204, 21, 0.25);
    }
    :root[data-theme="light"] .theme-toggle-btn:hover {
      border-color: #fde047;
      color: #fde047;
      background: rgba(15, 23, 42, 0.95);
      transform: translateY(-50%) scale(1.1);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4), 0 0 16px rgba(250, 204, 21, 0.45);
    }
    :root[data-theme="light"] .theme-toggle-btn:active {
      transform: translateY(-50%) scale(0.95);
    }
    @media (max-width: 768px) {
      .theme-toggle-btn {
        right: 12px;
        width: 40px;
        height: 40px;
      }
      .toolbar-right { right: 12px; }
    }
    .admin-btn.active {
      background: var(--primary);
      border-color: var(--primary);
      color: var(--button-text);
      font-weight: 700;
    }
    :root:not(.admin-mode) .admin-action,
    :root:not(.admin-mode) .card-actions,
    :root:not(.admin-mode) .drag-handle {
      display: none !important;
    }
    :root.admin-mode .auth-token {
      display: none !important;
    }
    .auth-token {
      background: var(--input-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 5px 8px;
      border-radius: 6px;
      outline: none;
      font-size: 12px;
    }
    .auth-token:focus { border-color: var(--primary); }
    .btn {
      background: var(--primary);
      color: var(--button-text);
      border: none;
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
      transition: all 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn:disabled, .theme-toggle-btn:disabled { opacity: 0.55; cursor: wait; }
    .btn-secondary { background: var(--secondary-bg); border: 1px solid var(--border); color: var(--secondary-text); }
    .btn-secondary:hover { filter: brightness(0.92); }

    /* 6 列响应式网格系统 */
    .grid { 
      display: grid; 
      grid-template-columns: repeat(6, 1fr); 
      gap: 11px; 
    }
    .route-card.filter-other-category { order: 1; }
    .route-card.filter-other-category-start { grid-column: 1; }
    .filter-group-divider {
      order: 1;
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 5px 0 1px;
      color: var(--tag-text);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .filter-group-divider span {
      color: var(--button-text);
      background: var(--primary);
      padding: 4px 12px;
      border-radius: 999px;
    }
    .filter-group-divider::before,
    .filter-group-divider::after {
      content: '';
      height: 1px;
      flex: 1;
      background: linear-gradient(90deg, transparent, var(--tag-border));
    }
    .filter-group-divider::after {
      background: linear-gradient(90deg, var(--tag-border), transparent);
    }
    @media (max-width: 1600px) { .grid { grid-template-columns: repeat(5, 1fr); } }
    @media (max-width: 1400px) { .grid { grid-template-columns: repeat(4, 1fr); } }
    @media (max-width: 1100px) { .grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 780px)  { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 500px)  { .grid { grid-template-columns: 1fr; } }
    :root.simple-view .grid { grid-template-columns: repeat(auto-fill, 150px); }
    :root.simple-view .route-card {
      width: 130px;
      height: 130px;
      min-height: 100px;
    }
    .simple-card-action { display: none; }
    :root.admin-mode.simple-view .card-top .card-actions { display: none; }
    :root.admin-mode.simple-view .simple-card-action {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 20px;
      padding: 2px 0;
      background: transparent;
      border: 0;
      color: var(--action);
      cursor: pointer;
      font-size: 13px;
    }
    :root.admin-mode.simple-view .simple-card-action.del { color: var(--danger); }
    :root.admin-mode.simple-view .link-info { justify-content: space-between; gap: 4px; }

    .card {
      background: var(--route-card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      height: 158px;
      min-height: 158px;
      overflow: hidden;
      box-shadow: var(--card-shadow);
      backdrop-filter: blur(12px) saturate(135%);
      -webkit-backdrop-filter: blur(12px) saturate(135%);
      text-shadow: var(--text-shadow);
      transition: all 0.2s;
    }
    .card:hover { border-color: var(--primary); transform: translateY(-2px); }
    .route-card.is-dragging {
      opacity: 0.42;
      border-color: var(--primary);
      transform: scale(0.98);
    }

    .card-top { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      gap: 6px; 
    }
    .card-title-wrap {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding-left: 4px;
    }
    .badge {
      font-weight: 600;
      font-size: 12px;
      color: var(--primary);
      background: rgba(56, 189, 248, 0.12);
      padding: 3px 8px;
      border-radius: 999px;
      line-height: 1.1;
      white-space: nowrap;
    }
    .card-title {
      font-weight: 700;
      font-size: 15px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-title, .badge, .category-badge, .label, .val, .target-text, .tag {
      text-shadow: var(--text-shadow);
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      align-content: flex-start;
      gap: 4px;
      height: 44px;
      min-height: 44px;
      max-height: 44px;
      overflow: hidden;
      min-width: 0;
    }
    .category-badge {
      display: inline-flex;
      align-items: center;
      color: var(--category);
      background: var(--category-bg);
      border: 1px solid var(--category-border);
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: 0.2px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .tags {
      display: flex;
      gap: 4px;
      flex-wrap: nowrap;
      overflow: hidden;
      min-width: 0;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      color: var(--tag-text);
      background: var(--tag-bg);
      border: 1px solid var(--tag-border);
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: 0.1px;
      white-space: nowrap;
      flex-shrink: 0;
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .tag:hover { transform: translateY(-1px); filter: brightness(1.08); }
    .card-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .drag-handle {
      color: var(--text-soft);
      cursor: grab;
      font-size: 16px;
      font-weight: 700;
      line-height: 1;
      padding: 0 2px 0 0;
      flex-shrink: 0;
      user-select: none;
      touch-action: none;
      transition: color 0.15s ease, opacity 0.15s ease;
    }
    .drag-handle:hover { color: var(--primary); }
    .drag-handle:active { cursor: grabbing; }
    .drag-handle[aria-disabled="true"] {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .action-link {
      background: transparent;
      border: none;
      color: var(--action);
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      padding: 2px;
      transition: color 0.15s;
    }
    .action-link:hover { color: var(--primary); }
    .action-link.del:hover { color: var(--danger); }

    /* 主体内容布局 */
    .card-body {
      display: flex;
      align-items: center;
      flex: 1;
      min-height: 0;
    }
    .link-info {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      min-width: 0;
    }
    .link-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-width: 0;
      padding-left: 4px;
    }
    :root.simple-view .link-col { display: none; }
    :root.simple-view .link-info { justify-content: center; }
    .link-row {
      display: flex;
      flex-direction: column;
      word-break: break-all;
      line-height: 1.35;
      min-width: 0;
    }
    .label { color: var(--label); font-size: 11.5px; font-weight: 600; margin-bottom: 1px; letter-spacing: 0.2px; }
    .val { 
      color: var(--target); 
      word-break: break-all; 
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .val.navigation-address {
      display: block;
      min-width: 0;
      overflow: visible;
      overflow-wrap: normal;
      text-overflow: clip;
      white-space: nowrap;
    }
    :root:not(.simple-view) .link-info { position: relative; }
    :root:not(.simple-view) .jump-btn-square {
      position: absolute;
      top: 50%;
      right: 0;
      z-index: 2;
      transform: translateY(calc(-50% - 10px));
    }
    :root.simple-view .jump-btn-square { transform: translateY(0px); }
    .target-text { 
      display: block;
      width: 100%;
      min-width: 0;
      color: var(--target); 
      font-size: 12.5px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      word-break: normal;
    }

    /* 右侧放大模式跳转按钮 */
    .jump-btn-square {
      width: 48px;
      height: 48px;
      transform: translateY(-1px);
      flex-shrink: 0;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--primary);
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      gap: 3px;
      transition: all 0.2s ease;
    }
    .jump-btn-square.btn-direct {
      background: rgba(192, 132, 252, 0.1);
      border-color: rgba(192, 132, 252, 0.3);
      color: var(--direct);
    }
    .jump-btn-square svg {
      width: 17px;
      height: 17px;
      stroke: currentColor;
      transition: transform 0.2s;
    }
    .jump-btn-square .jump-arrow {
      font-size: 20px;
      line-height: 17px;
    }
    .jump-btn-square:hover {
      background: var(--primary);
      color: var(--button-text);
      border-color: var(--primary);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.4);
    }
    .jump-btn-square.btn-direct:hover {
      background: var(--direct);
      color: var(--button-text);
      border-color: var(--direct);
      box-shadow: 0 0 12px rgba(192, 132, 252, 0.4);
    }
    .jump-btn-square:hover svg,
    .jump-btn-square:hover .jump-arrow {
      transform: translate(1.5px, -1.5px);
    }

    /* 弹窗 Modal */
    .modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 99;
      padding: 16px;
    }
    .modal.show { display: flex; }
    .modal-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
      width: 100%;
      max-width: 420px;
      color: var(--text);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    .modal-box h2 { font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 14px; }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-soft); margin-bottom: 6px; }
    .form-group #target-label { min-height: 28px; line-height: 14px; }
    #subdomain-group[hidden] { display: block; visibility: hidden; }
    .required-star { color: var(--danger); font-weight: 700; margin-left: 2px; }
    .form-group input {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 10px;
      border-radius: 6px;
      outline: none;
      font-size: 13px;
    }
    .form-group input:focus { border-color: var(--primary); }
    .target-path-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(90px, 0.36fr);
      gap: 8px;
    }
    .target-path-fields label { min-height: 28px; line-height: 14px; }

    /* 左右点选模式选择器 (Segmented Switch) */
    .segmented-control {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px;
      background: var(--input-bg);
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .segment-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-soft);
      padding: 6px 2px;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      white-space: normal;
      min-width: 0;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
    }
    .segment-btn small { font-size: 12px; line-height: 1.1; }
    .segment-btn:hover {
      color: var(--text);
    }
    /* 反代模式激活样式 */
    .segment-btn[data-val="1"].active {
      background: rgba(56, 189, 248, 0.18);
      border-color: var(--primary);
      color: var(--primary);
      font-weight: 700;
    }
    /* 直连模式激活样式 */
    .segment-btn[data-val="0"].active {
      background: rgba(192, 132, 252, 0.18);
      border-color: var(--direct);
      color: var(--direct);
      font-weight: 700;
    }
    .segment-btn[data-val="2"].active {
      background: rgba(52, 211, 153, 0.18);
      border-color: var(--success);
      color: var(--success);
      font-weight: 700;
    }
    .modal-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="filters">
      <div class="filter-header-row">
        <div id="category-filter" class="filter-options">
          <button type="button" class="filter-chip active" data-value="" onclick="selectFilter('category-filter', this)">全部分类</button>
          <button type="button" class="filter-chip" data-value="" data-uncategorized="true" onclick="selectFilter('category-filter', this)">未分类</button>
          ${categories.map((category) => `<button type="button" class="filter-chip" data-value="${escapeHtml(category)}" onclick="selectFilter('category-filter', this)">${escapeHtml(category)}</button>`).join('')}
          <button class="theme-toggle filter-clear" type="button" onclick="clearFilters()">清除筛选</button>
        </div>
        <div class="toolbar-right">
          <button id="admin-toggle" class="theme-toggle admin-btn" type="button" onclick="toggleAdminMode()" title="切换管理模式">⚙️ Admin</button>
          ${needPassword ? `<input id="auth-token" class="auth-token" type="password" placeholder="输入管理密码" onkeydown="if(event.key==='Enter') toggleAdminMode()" />` : ''}
          <button class="theme-toggle-btn admin-action add-service-toggle" type="button" onclick="openModal()" title="添加新服务" aria-label="添加新服务">+</button>
        </div>
      </div>
      <div id="tag-filter" class="filter-options">
        <button type="button" class="filter-chip active" data-value="" onclick="selectFilter('tag-filter', this)">全部标签</button>
        ${tags.map((tag) => `<button type="button" class="filter-chip" data-value="${escapeHtml(tag.toLowerCase())}" onclick="selectFilter('tag-filter', this)">${escapeHtml(tag)}</button>`).join('')}
      </div>
    </div>

    <div class="grid" id="routes-container">
      ${routes.map(r => {
        const category = r.category?.trim() || '';
        const routeTags = normalizeTags(r.tags);
        const fullUrl = `https://${r.subdomain}.${baseDomain}`;
        const mode = Number(r.enabled);
        const isProxy = mode === 1;
        const isCloudflareRoute = mode === 2;
        const editData = escapeHtml(JSON.stringify({ ...r, category, tags: routeTags.join(', ') }));
        const subdomain = escapeHtml(r.subdomain);
        const rawTitle = r.title?.trim() || (isCloudflareRoute ? 'Worker 路由服务' : isProxy ? '反代服务' : '直连服务');
        const title = escapeHtml(rawTitle);
        const targetUrl = escapeHtml(r.target_url);
        const directUrl = /^https?:\/\//i.test(r.target_url)
          ? r.target_url
          : `https://${r.target_url}`;
        const navigationBaseUrl = isProxy || isCloudflareRoute ? fullUrl : directUrl;
        const navigationUrl = escapeHtml(appendNavigationPath(navigationBaseUrl, r.navigation_path));
        const navigationLabel = isProxy || isCloudflareRoute ? '入口' : '目标';
        const navigationText = navigationUrl;
        return `
          <div class="card route-card" data-id="${r.id ?? ''}" data-subdomain="${subdomain}" data-category="${escapeHtml(category)}" data-tags="${escapeHtml(routeTags.map((tag) => tag.toLowerCase()).join('|'))}">
            <div class="card-top">
              <div class="card-title-wrap">
                <span class="drag-handle" draggable="false" aria-disabled="true" title="开启 Admin 后可拖拽排序">⠿</span>
                <span class="card-title" title="${title}">${title}</span>
              </div>
              <div class="card-actions">
                <button class="action-link" onclick="editRoute(${editData})" title="编辑">✏️</button>
                <button class="action-link del" onclick="deleteRoute(${r.id !== undefined && r.id !== null ? r.id : 'null'}, ${escapeHtml(JSON.stringify(rawTitle || r.subdomain))})" title="删除">🗑️</button>
              </div>
            </div>

            <div class="meta-row">
              <span class="category-badge">${category ? escapeHtml(category) : '未分类'}</span>
              ${routeTags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('')}
            </div>
            
            <div class="card-body">
              <div class="link-info">
                <button type="button" class="simple-card-action" onclick="editRoute(${editData})" title="编辑" aria-label="编辑">✏️</button>
                <div class="link-col">
                  ${isCloudflareRoute ? `
                  <div class="link-row">
                    <span class="label">Worker</span>
                    <span class="val" title="${targetUrl}">${targetUrl}</span>
                  </div>
                  <div class="link-row">
                    <span class="label">地址</span>
                    <span class="val navigation-address" title="${navigationUrl}">${navigationUrl}</span>
                  </div>` : `
                  <div class="link-row">
                    <span class="label">${navigationLabel}</span>
                    <span class="val navigation-address" title="${navigationText}">${navigationText}</span>
                  </div>
                  ${isProxy ? `
                  <div class="link-row">
                    <span class="label">目标</span>
                    <span class="target-text" title="${targetUrl}">${targetUrl}</span>
                  </div>` : ''}`}
                </div>
                <a href="${navigationUrl}" target="_blank" class="jump-btn-square ${isProxy || isCloudflareRoute ? 'btn-proxy' : 'btn-direct'}" title="打开服务">
                  <span class="jump-arrow">${isProxy ? '↩' : isCloudflareRoute ? '↪' : '➞'}</span>
                  <span>${isCloudflareRoute ? '路由' : isProxy ? '反代' : '直连'}</span>
                </a>
                <button type="button" class="simple-card-action del" onclick="deleteRoute(${r.id !== undefined && r.id !== null ? r.id : 'null'}, ${escapeHtml(JSON.stringify(rawTitle || r.subdomain))})" title="删除" aria-label="删除">🗑️</button>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  </div>

  <!-- 编辑/新建 弹窗 -->
  <div class="modal" id="form-modal">
    <div class="modal-box">
      <h2 id="modal-title">添加服务</h2>
      <input type="hidden" id="ipt-id" value="">
      <div class="form-group">
        <label>访问模式</label>
        <!-- 左右点选模式组件 -->
        <input type="hidden" id="ipt-enabled" value="1">
        <div class="segmented-control">
          <button type="button" class="segment-btn active" data-val="1" onclick="setMode(1)">
            <span>↩ 反代模式</span><small>(Pages)</small>
          </button>
          <button type="button" class="segment-btn" data-val="2" onclick="setMode(2)">
            <span>↪ 路由模式</span><small>(Workers)</small>
          </button>
          <button type="button" class="segment-btn" data-val="0" onclick="setMode(0)">
            <span>➞ 直连模式</span><small>(Direct)</small>
          </button>
        </div>
      </div>
      <div class="form-group">
        <label>备注名称 (例如: 个人博客)</label>
        <input type="text" id="ipt-title" placeholder="">
      </div>
      <div class="form-group">
        <label>分类 (例如: 个人站点)</label>
        <input type="text" id="ipt-category" placeholder="">
      </div>
      <div class="form-group">
        <label>标签 (多个标签用逗号分隔,例如:API,cloudflare,影视)</label>
        <input type="text" id="ipt-tags" placeholder="">
      </div>
      <div class="form-group">
        <div class="target-path-fields">
          <div>
            <label id="target-label">目标 URL <span class="required-star">*</span> (必填，例如: https://blog.example.com)</label>
            <input type="text" id="ipt-target" placeholder="必填">
          </div>
          <div>
            <label for="ipt-navigation-path">路径 (仅用于跳转)</label>
            <input type="text" id="ipt-navigation-path" placeholder="/path">
          </div>
        </div>
      </div>
      <div class="form-group" id="subdomain-group">
        <label>子域名前缀 <span class="required-star">*</span> (必填，例如: blog)</label>
        <input type="text" id="ipt-subdomain" placeholder="必填">
      </div>
      <div class="modal-buttons">
        <button class="btn btn-secondary" onclick="closeModal()">取消</button>
        <button type="button" class="btn" onclick="saveRoute()">保存</button>
      </div>
    </div>
  </div>

  <button id="theme-toggle" class="theme-toggle-btn" type="button" onclick="toggleTheme()" title="切换主题" aria-label="切换主题">☀️</button>
  <button id="display-mode-toggle" class="theme-toggle-btn display-mode-toggle" type="button" onclick="toggleCardDisplayMode()" title="切换为简要显示" aria-label="切换为简要显示">简</button>

  <script>
    const BUTTON_CLICK_LOCK_MS = 3000;
    let isEditing = false;
    let draggedRouteCard = null;
    let routeOrderChanged = false;
    let dragInitialKeys = [];
    let dragVisibleSlots = [];
    let routeOrderSaveQueue = Promise.resolve();
    const sunSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="currentColor"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
    const moonSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

    function updateThemeButton() {
      const button = document.getElementById('theme-toggle');
      if (!button) return;
      const isLight = document.documentElement.dataset.theme === 'light';
      button.innerHTML = isLight ? moonSvg : sunSvg;
      button.title = isLight ? '切换为深色模式' : '切换为浅色模式';
    }

    function toggleTheme() {
      const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = nextTheme;
      localStorage.setItem('route_theme', nextTheme);
      updateThemeButton();
    }

    function updateCardDisplayModeButton() {
      const button = document.getElementById('display-mode-toggle');
      if (!button) return;
      const isSimpleView = document.documentElement.classList.contains('simple-view');
      const nextMode = isSimpleView ? '详细' : '简要';
      button.textContent = isSimpleView ? '详' : '简';
      button.title = '切换为' + nextMode + '显示';
      button.setAttribute('aria-label', '切换为' + nextMode + '显示');
    }

    function setCardDisplayMode(isSimpleView) {
      document.documentElement.classList.toggle('simple-view', isSimpleView);
      localStorage.setItem('route_simple_view', isSimpleView ? '1' : '0');
      updateCardDisplayModeButton();
    }

    function toggleCardDisplayMode() {
      setCardDisplayMode(!document.documentElement.classList.contains('simple-view'));
    }

    function lockButtonForThreeSeconds(button) {
      if (!button || button.disabled) return false;
      button.disabled = true;
      window.setTimeout(() => { button.disabled = false; }, BUTTON_CLICK_LOCK_MS);
      return true;
    }

    function updateAdminModeUI(enabled) {
      document.documentElement.classList.toggle('admin-mode', enabled);
      const btn = document.getElementById('admin-toggle');
      if (btn) {
        btn.classList.toggle('active', enabled);
        btn.title = enabled ? '管理模式已开启，点击隐藏操作按钮' : '点击开启管理模式';
      }
      updateRouteSortingAvailability();
    }

    async function toggleAdminMode() {
      const isCurrentlyAdmin = document.documentElement.classList.contains('admin-mode');
      if (isCurrentlyAdmin) {
        localStorage.setItem('admin_mode', '0');
        setCardDisplayMode(true);
        updateAdminModeUI(false);
        return;
      }

      const pwdInput = document.getElementById('auth-token');
      if (pwdInput) {
        const pwd = pwdInput.value.trim();
        if (!pwd) {
          alert('请输入管理密码后开启管理模式！');
          pwdInput.focus();
          return;
        }
        try {
          const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': pwd }
          });
          const result = await res.json();
          if (!res.ok || result.error) {
            alert(result.error || '管理密码错误，鉴权失败！');
            pwdInput.focus();
            return;
          }
          localStorage.setItem('admin_pwd', pwd);
        } catch (e) {
          alert('鉴权失败: ' + e.message);
          return;
        }
      }

      localStorage.setItem('admin_mode', '1');
      setCardDisplayMode(false);
      updateAdminModeUI(true);
    }

    function getActiveFilterValue(groupId) {
      return document.querySelector('#' + groupId + ' .filter-chip.active')?.dataset.value || '';
    }

    function getActiveFilterValues(groupId) {
      return [...document.querySelectorAll('#' + groupId + ' .filter-chip.active')]
        .map((chip) => chip.dataset.value)
        .filter(Boolean);
    }

    function selectFilter(groupId, button) {
      const isTagFilter = groupId === 'tag-filter';
      const chips = document.querySelectorAll('#' + groupId + ' .filter-chip');
      if (isTagFilter && button.dataset.value) {
        button.classList.toggle('active');
        const allButton = document.querySelector('#' + groupId + ' .filter-chip[data-value=""]');
        if (allButton) allButton.classList.remove('active');
        if (!document.querySelector('#' + groupId + ' .filter-chip.active')) {
          allButton?.classList.add('active');
        }
      } else {
        chips.forEach((chip) => chip.classList.toggle('active', chip === button));
      }
      filterRoutes();
    }

    function filterRoutes() {
      const activeCategory = document.querySelector('#category-filter .filter-chip.active');
      const category = getActiveFilterValue('category-filter');
      const uncategorizedOnly = activeCategory?.dataset.uncategorized === 'true';
      const selectedTags = getActiveFilterValues('tag-filter');
      sessionStorage.setItem('route-filters', JSON.stringify({
        category: uncategorizedOnly ? null : category,
        uncategorized: uncategorizedOnly,
        tags: selectedTags
      }));
      document.querySelectorAll('.route-card').forEach((card) => {
        const matchesCategory = uncategorizedOnly
          ? !card.dataset.category
          : !category || card.dataset.category === category;
        const cardTags = card.dataset.tags.split('|');
        const matchesTag = !selectedTags.length || selectedTags.every((tag) => cardTags.includes(tag));
        const splitCategoryGroups = (uncategorizedOnly || !!category) && selectedTags.length > 0;
        const matchesOtherCategory = uncategorizedOnly
          ? !!card.dataset.category
          : card.dataset.category !== category;
        const showOtherCategory = splitCategoryGroups && !matchesCategory && matchesOtherCategory && matchesTag;
        card.style.display = (matchesCategory && matchesTag) || showOtherCategory ? '' : 'none';
        card.classList.toggle('filter-other-category', showOtherCategory);
        card.classList.remove('filter-other-category-start');
      });
      const firstOtherCategoryCard = document.querySelector('.route-card.filter-other-category:not([style*="display: none"])');
      document.querySelector('.filter-group-divider')?.remove();
      if (firstOtherCategoryCard) {
        firstOtherCategoryCard.classList.add('filter-other-category-start');
        const divider = document.createElement('div');
        divider.className = 'filter-group-divider';
        divider.innerHTML = '<span>其他分类</span>';
        firstOtherCategoryCard.before(divider);
      }
      updateRouteSortingAvailability();
    }

    function restoreRouteFilters() {
      const saved = sessionStorage.getItem('route-filters');
      if (!saved) return;

      try {
        const filters = JSON.parse(saved);
        const categoryButtons = [...document.querySelectorAll('#category-filter .filter-chip')];
        const categoryButton = filters.uncategorized
          ? categoryButtons.find((button) => button.dataset.uncategorized === 'true')
          : categoryButtons.find((button) => button.dataset.value === filters.category);
        if (categoryButton) {
          categoryButtons.forEach((button) => button.classList.toggle('active', button === categoryButton));
        }

        const tagButtons = [...document.querySelectorAll('#tag-filter .filter-chip')];
        const selectedTagButtons = tagButtons.filter((button) => filters.tags?.includes(button.dataset.value));
        if (selectedTagButtons.length) {
          tagButtons.forEach((button) => button.classList.toggle('active', selectedTagButtons.includes(button)));
        }
      } catch {
        sessionStorage.removeItem('route-filters');
      }
    }

    function clearFilters() {
      document.querySelectorAll('.filter-options').forEach((group) => {
        const allButton = group.querySelector('.filter-chip[data-value=""]');
        group.querySelectorAll('.filter-chip').forEach((chip) => {
          chip.classList.toggle('active', chip === allButton);
        });
      });
      filterRoutes();
    }

    function canReorderRoutes() {
      return document.documentElement.classList.contains('admin-mode');
    }

    function updateRouteSortingAvailability() {
      const enabled = canReorderRoutes();
      const disabledTitle = '开启 Admin 后可拖拽排序';

      document.querySelectorAll('.drag-handle').forEach((handle) => {
        handle.setAttribute('draggable', enabled ? 'true' : 'false');
        handle.setAttribute('aria-disabled', enabled ? 'false' : 'true');
        handle.title = enabled ? '拖拽调整卡片顺序' : disabledTitle;
      });
    }

    function initializeRouteSorting() {
      const routesContainer = document.getElementById('routes-container');
      if (!routesContainer) return;

      routesContainer.querySelectorAll('.drag-handle').forEach((handle) => {
        handle.addEventListener('dragstart', (event) => {
          if (!canReorderRoutes()) {
            event.preventDefault();
            return;
          }

          draggedRouteCard = handle.closest('.route-card');
          if (!draggedRouteCard) {
            event.preventDefault();
            return;
          }

          routeOrderChanged = false;
          const allCards = [...routesContainer.querySelectorAll('.route-card')];
          dragInitialKeys = allCards.map((card) => card.dataset.id || card.dataset.subdomain).filter(Boolean);
          dragVisibleSlots = [];
          allCards.forEach((card, index) => {
            if (card.style.display !== 'none') {
              dragVisibleSlots.push(index);
            }
          });

          draggedRouteCard.classList.add('is-dragging');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggedRouteCard.dataset.id || draggedRouteCard.dataset.subdomain || '');
        });

        handle.addEventListener('dragend', () => {
          const shouldSave = routeOrderChanged;
          if (draggedRouteCard) {
            draggedRouteCard.classList.remove('is-dragging');
          }
          draggedRouteCard = null;
          routeOrderChanged = false;
          if (shouldSave) queueRouteOrderSave();
        });
      });

      routesContainer.addEventListener('dragover', (event) => {
        if (!draggedRouteCard || !canReorderRoutes()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      });

      routesContainer.addEventListener('drop', (event) => {
        if (!draggedRouteCard || !canReorderRoutes()) return;
        event.preventDefault();
      });

      routesContainer.querySelectorAll('.route-card').forEach((targetCard) => {
        targetCard.addEventListener('dragover', (event) => {
          if (
            !draggedRouteCard ||
            draggedRouteCard === targetCard ||
            !canReorderRoutes()
          ) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          const rect = targetCard.getBoundingClientRect();
          const insertBefore = event.clientX < rect.left + rect.width / 2;
          const insertionPoint = insertBefore ? targetCard : targetCard.nextSibling;
          const isAlreadyInPosition = insertBefore
            ? draggedRouteCard.nextSibling === targetCard
            : draggedRouteCard.previousSibling === targetCard;

          if (!isAlreadyInPosition && insertionPoint !== draggedRouteCard) {
            routesContainer.insertBefore(draggedRouteCard, insertionPoint);
            routeOrderChanged = true;
          }
        });
      });

      updateRouteSortingAvailability();
    }

    function queueRouteOrderSave() {
      routeOrderSaveQueue = routeOrderSaveQueue
        .catch(() => {})
        .then(() => saveRouteOrder());
    }

    async function saveRouteOrder() {
      const routesContainer = document.getElementById('routes-container');
      if (!routesContainer) return;

      const currentCards = [...routesContainer.querySelectorAll('.route-card')];
      const currentVisibleCards = currentCards.filter((card) => card.style.display !== 'none');
      const currentVisibleKeys = currentVisibleCards
        .map((card) => card.dataset.id || card.dataset.subdomain)
        .filter(Boolean);

      let finalKeys = [];
      if (
        dragInitialKeys.length === currentCards.length &&
        dragVisibleSlots.length === currentVisibleKeys.length
      ) {
        finalKeys = [...dragInitialKeys];
        dragVisibleSlots.forEach((slotIndex, i) => {
          finalKeys[slotIndex] = currentVisibleKeys[i];
        });
      } else {
        finalKeys = currentCards
          .map((card) => card.dataset.id || card.dataset.subdomain)
          .filter(Boolean);
      }

      // 按槽位映射后的全量顺序规范化 DOM 树，保证全量与过滤视图一致
      const cardMap = new Map();
      currentCards.forEach((card) => {
        const key = card.dataset.id || card.dataset.subdomain;
        if (key) {
          cardMap.set(key, card);
        }
      });
      finalKeys.forEach((key) => {
        const card = cardMap.get(key);
        if (card) {
          routesContainer.appendChild(card);
        }
      });

      const hasNumericIds = finalKeys.length > 0 && finalKeys.every((val) => /^d+$/.test(String(val)));
      const payload = hasNumericIds
        ? { ids: finalKeys.map(Number) }
        : { subdomains: finalKeys };

      try {
        const res = await fetch('/api/admin/reorder', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '排序保存失败');
      } catch (err) {
        alert('排序保存失败：' + err.message + '，页面将恢复为已保存的顺序。');
        location.reload();
      }
    }

    // 左右点选切换模式
    function setMode(val) {
      document.getElementById('ipt-enabled').value = val;
      const isCloudflareRoute = parseInt(val, 10) === 2;
      const isDirect = parseInt(val, 10) === 0;
      const tagsInput = document.getElementById('ipt-tags');
      if (isCloudflareRoute) {
        const tags = tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean);
        if (!tags.some(tag => tag.toLowerCase() === 'cloudflare')) {
          tags.push('cloudflare');
        }
        tagsInput.value = tags.join(', ');
      }
      const subdomainGroup = document.getElementById('subdomain-group');
      const subdomainInput = document.getElementById('ipt-subdomain');
      subdomainGroup.hidden = isDirect;
      if (isDirect) subdomainInput.value = '';
      document.getElementById('target-label').innerHTML = isCloudflareRoute
        ? '目标 Worker 名称 <span class="required-star">*</span> (必填，填写Cloudflare中Worker的项目名称，例如 edg。)'
        : '目标 URL <span class="required-star">*</span> (必填，例如: https://blog.example.com)';
      const btns = document.querySelectorAll('.segment-btn');
      btns.forEach(btn => {
        if (parseInt(btn.getAttribute('data-val'), 10) === parseInt(val, 10)) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }

    function getAuthHeaders() {
      const pwdInput = document.getElementById('auth-token');
      const pwd = (pwdInput ? pwdInput.value.trim() : '') || localStorage.getItem('admin_pwd') || '';
      const headers = { 'Content-Type': 'application/json' };
      if (pwd) {
        headers['x-admin-password'] = pwd;
        localStorage.setItem('admin_pwd', pwd);
      }
      return headers;
    }

    window.addEventListener('DOMContentLoaded', () => {
      updateThemeButton();
      const formModal = document.getElementById('form-modal');
      formModal.addEventListener('click', (event) => {
        if (event.target === formModal) closeModal();
      });
      const pwdInput = document.getElementById('auth-token');
      if (pwdInput && localStorage.getItem('admin_pwd')) {
        pwdInput.value = localStorage.getItem('admin_pwd');
      }
      const adminEnabled = localStorage.getItem('admin_mode') === '1' && (!${needPassword} || !!localStorage.getItem('admin_pwd'));
      const savedDisplayMode = localStorage.getItem('route_simple_view');
      setCardDisplayMode(savedDisplayMode !== '0');
      restoreRouteFilters();
      filterRoutes();
      initializeRouteSorting();
      updateAdminModeUI(adminEnabled);
    });

    function openModal(data = null) {
      if (!data && !lockButtonForThreeSeconds(document.querySelector('.add-service-toggle'))) return;
      isEditing = !!data;
      document.getElementById('modal-title').innerText = isEditing ? '编辑服务' : '添加服务';
      document.getElementById('ipt-id').value = data && data.id !== undefined && data.id !== null ? data.id : '';
      const subInput = document.getElementById('ipt-subdomain');
      subInput.value = data ? (data.subdomain || '') : '';
      subInput.disabled = false;
      document.getElementById('ipt-title').value = data ? (data.title || '') : '';
      document.getElementById('ipt-category').value = data ? (data.category || '') : '';
      document.getElementById('ipt-tags').value = data ? (data.tags || '') : '';
      document.getElementById('ipt-target').value = data ? (data.target_url || '') : '';
      document.getElementById('ipt-navigation-path').value = data ? (data.navigation_path || '') : '';
      
      // 设置默认或已存在的模式
      setMode(data ? data.enabled : 1);

      document.getElementById('form-modal').classList.add('show');
    }

    function closeModal() {
      document.getElementById('form-modal').classList.remove('show');
    }

    function editRoute(data) {
      openModal(data);
    }

    function getModalInputValue(id) {
      const modal = document.getElementById('form-modal');
      const input = modal ? modal.querySelector('#' + id) : null;
      if (!input) return '';
      return String(input.value || input.getAttribute('value') || '').trim();
    }

    async function saveRoute() {
      const modal = document.getElementById('form-modal');
      const saveButton = modal?.querySelector('.modal-buttons button[type="button"]');
      const targetInput = modal ? modal.querySelector('#ipt-target') : null;
      const id = getModalInputValue('ipt-id');
      const subdomain = getModalInputValue('ipt-subdomain');
      const title = getModalInputValue('ipt-title');
      const category = getModalInputValue('ipt-category');
      const tags = getModalInputValue('ipt-tags');
      const target_url = getModalInputValue('ipt-target');
      const navigation_path = getModalInputValue('ipt-navigation-path');
      const enabled = parseInt(document.getElementById('ipt-enabled').value, 10);

      if (!modal || !targetInput) {
        alert('服务表单加载失败，请刷新页面后重试！');
        return;
      }

      if ((!subdomain && enabled !== 0) || !target_url) {
        alert(!subdomain && enabled !== 0 ? '子域名前缀不能为空！' : '目标地址不能为空！');
        return;
      }

      let normalizedTargetUrl = String(target_url || '').trim();
      if (enabled !== 2) {
        if (!normalizedTargetUrl.startsWith('http://') && !normalizedTargetUrl.startsWith('https://')) {
          normalizedTargetUrl = 'https://' + normalizedTargetUrl;
        }
        while (normalizedTargetUrl.endsWith('/')) {
          normalizedTargetUrl = normalizedTargetUrl.slice(0, -1);
        }
      }
      targetInput.value = normalizedTargetUrl;

      const payload = {
        subdomain: subdomain.toLowerCase(),
        title,
        category,
        tags,
        target_url: normalizedTargetUrl,
        navigation_path,
        enabled
      };
      if (id) {
        payload.id = Number(id);
      }

      if (!lockButtonForThreeSeconds(saveButton)) return;
      try {
        const res = await fetch('/api/admin/save', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '保存失败');
        location.reload();
      } catch (err) {
        alert(err.message);
      }
    }

    async function deleteRoute(id, name) {
      if (!confirm('确定要删除 ' + (name || '此服务') + ' 吗？')) return;

      try {
        const payload = id !== null && id !== undefined ? { id: Number(id) } : { subdomain: name };
        const res = await fetch('/api/admin/delete', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '删除失败');
        location.reload();
      } catch (err) {
        alert(err.message);
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}
