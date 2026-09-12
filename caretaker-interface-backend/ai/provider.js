'use strict';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Models that support NVIDIA's chat_template_kwargs for disabling thinking
const THINKING_DISABLED_MODELS = new Set([
    'nvidia/nemotron-3.5-lightning-30b-a3b'
]);

function getApiKey() {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) {
        throw new Error('[Wall-E] NVIDIA_API_KEY is not set. Cannot make AI requests.');
    }
    return key;
}

function buildBody(model, messages, options) {
    const temperature = options.temperature ?? 0.3;
    const maxTokens = options.maxTokens ?? 256;

    const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
    };

    if (THINKING_DISABLED_MODELS.has(model)) {
        body.chat_template_kwargs = { enable_thinking: false };
    }

    return body;
}

/**
 * Call a single NVIDIA NIM model.
 *
 * @param {object} params
 * @param {string} params.model - Model identifier
 * @param {Array<{role: string, content: string}>} params.messages - Chat messages
 * @param {number} [params.temperature] - Sampling temperature
 * @param {number} [params.maxTokens] - Max response tokens
 * @param {number} [params.timeoutMs] - Request timeout in ms
 * @returns {Promise<{reply: string, model: string, latencyMs: number}>}
 * @throws {Error} On provider, network, or configuration errors
 */
async function callModel({ model, messages, temperature, maxTokens, timeoutMs }) {
    const apiKey = getApiKey();
    const timeout = timeoutMs || 10000;

    const body = buildBody(model, messages, { temperature, maxTokens });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const startMs = Date.now();

    try {
        const response = await fetch(NVIDIA_BASE_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timer);
        const latencyMs = Date.now() - startMs;

        if (!response.ok) {
            const status = response.status;
            const errorBody = await response.text().catch(() => '');
            const err = new Error(`Provider returned HTTP ${status}`);
            err.status = status;
            err.providerBody = errorBody;
            err.latencyMs = latencyMs;
            throw err;
        }

        const data = await response.json();

        const content =
            data &&
            data.choices &&
            data.choices[0] &&
            data.choices[0].message &&
            typeof data.choices[0].message.content === 'string'
                ? data.choices[0].message.content.trim()
                : '';

        if (!content) {
            const err = new Error('Provider returned empty or unusable response');
            err.empty = true;
            err.latencyMs = latencyMs;
            throw err;
        }

        return {
            reply: content,
            model,
            latencyMs
        };
    } catch (err) {
        clearTimeout(timer);

        if (err.name === 'AbortError') {
            const timeoutErr = new Error(`Model ${model} timed out after ${timeout}ms`);
            timeoutErr.timeout = true;
            timeoutErr.latencyMs = Date.now() - startMs;
            throw timeoutErr;
        }

        if (!err.status && !err.empty && !err.timeout) {
            err.latencyMs = err.latencyMs || (Date.now() - startMs);
        }

        throw err;
    }
}

/**
 * Determine whether an error is a transient provider failure
 * eligible for fallback, vs a configuration/programming error
 * that should fail immediately.
 */
function isTransientError(err) {
    if (err.timeout) return true;
    if (err.name === 'AbortError') return true;

    const status = err.status;
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
    }

    if (err.empty) return true;

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound') ||
        msg.includes('fetch failed') || msg.includes('socket hang up')) {
        return true;
    }

    return false;
}

module.exports = { callModel, isTransientError };
