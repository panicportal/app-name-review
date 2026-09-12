const STORE_KEY = "panic:name-review:v12:state";

function redundantStoredValue(value) {
  return value === undefined || value === null || value === "" || value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => !redundantStoredValue(item))
  );
}

function compactCloudState(state) {
  if (!state?.curation?.records) return state;
  const records = {};
  for (const [id, record] of Object.entries(state.curation.records)) {
    const parts = {};
    for (const [key, part] of Object.entries(record?.parts || {})) {
      parts[key] = compactObject(part);
    }
    records[id] = { ...compactObject({ ...record, parts: undefined }), parts };
  }
  return {
    ...state,
    curation: {
      ...state.curation,
      records
    }
  };
}

function redisConfig() {
  return {
    url:
      process.env.UPSTASH_REDIS_REST_URL ||
      process.env.KV_REST_API_URL ||
      "",
    token:
      process.env.UPSTASH_REDIS_REST_TOKEN ||
      process.env.KV_REST_API_TOKEN ||
      "",
  };
}

async function command(args) {
  const { url, token } = redisConfig();
  if (!url || !token) {
    const error = new Error("Cloud storage is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const error = new Error(`Cloud storage returned HTTP ${response.status}.`);
    error.statusCode = 503;
    throw error;
  }
  const payload = await response.json();
  if (payload.error) {
    const error = new Error(payload.error);
    error.statusCode = 503;
    throw error;
  }
  return payload.result;
}

async function readState() {
  const raw = await command(["GET", STORE_KEY]);
  return raw ? JSON.parse(raw) : null;
}

async function writeState(state) {
  await command(["SET", STORE_KEY, JSON.stringify(compactCloudState(state))]);
  return state;
}

async function compareAndSwapState(expectedRevision, state) {
  const script = `
    local current = redis.call("GET", KEYS[1])
    if not current then return -1 end
    local decoded = cjson.decode(current)
    if tonumber(decoded.revision or 0) ~= tonumber(ARGV[1]) then return 0 end
    redis.call("SET", KEYS[1], ARGV[2])
    return 1
  `;
  const result = Number(await command([
    "EVAL",
    script,
    "1",
    STORE_KEY,
    String(Number(expectedRevision || 0)),
    JSON.stringify(compactCloudState(state)),
  ]));
  return result === 1;
}

async function readJson(key) {
  const raw = await command(["GET", key]);
  return raw ? JSON.parse(raw) : null;
}

async function writeJson(key, value) {
  await command(["SET", key, JSON.stringify(value)]);
  return value;
}

module.exports = {
  compareAndSwapState,
  compactCloudState,
  command,
  readJson,
  readState,
  STORE_KEY,
  writeJson,
  writeState,
};
