'use strict';

const { callModel, isTransientError } = require('./provider');

const DEFAULT_PRIMARY = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const DEFAULT_FALLBACK_1 = 'nvidia/nemotron-3-super-120b-a12b';
const DEFAULT_FALLBACK_2 = 'deepseek-ai/deepseek-v4-flash-0731';

function getModelList() {
    return [
        process.env.WALLE_MODEL_PRIMARY || DEFAULT_PRIMARY,
        process.env.WALLE_MODEL_FALLBACK_1 || DEFAULT_FALLBACK_1,
        process.env.WALLE_MODEL_FALLBACK_2 || DEFAULT_FALLBACK_2
    ];
}

function getTimeoutMs() {
    const raw = parseInt(process.env.WALLE_AI_TIMEOUT_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

/**
 * Send a chat completion request with automatic multi-model fallback.
 *
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages - Chat messages
 * @param {number} [params.temperature] - Sampling temperature
 * @param {number} [params.maxTokens] - Max response tokens
 * @returns {Promise<{reply: string, model: string}>}
 * @throws {Error} AI_PROVIDER_UNAVAILABLE if all models fail
 */
async function chatWithFallback({ messages, temperature, maxTokens }) {
    const models = getModelList();
    const timeoutMs = getTimeoutMs();
    let lastError = null;

    for (let i = 0; i < models.length; i++) {
        const model = models[i];

        try {
            const result = await callModel({
                model,
                messages,
                temperature,
                maxTokens,
                timeoutMs
            });

            if (i > 0) {
                console.log(`[Wall-E] fallback succeeded: ${model} (${i + 1} of ${models.length})`);
            } else {
                console.log(`[Wall-E] model success: ${model}`);
            }

            return { reply: result.reply, model: result.model };

        } catch (err) {
            lastError = err;
            const statusInfo = err.status ? ` status=${err.status}` : '';
            const extraInfo = err.timeout ? ' timeout' : '';
            console.warn(`[Wall-E] model failed: ${model}${statusInfo}${extraInfo}`);

            if (!isTransientError(err)) {
                console.error(`[Wall-E] non-transient error on ${model}: ${err.message}`);
                throw new Error('AI_PROVIDER_UNAVAILABLE');
            }

            if (i < models.length - 1) {
                console.log(`[Wall-E] trying fallback: ${models[i + 1]}`);
            }
        }
    }

    console.error(`[Wall-E] all ${models.length} models exhausted`);
    throw new Error('AI_PROVIDER_UNAVAILABLE');
}

module.exports = { chatWithFallback, getModelList, getTimeoutMs };
