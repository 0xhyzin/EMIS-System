import { createHash } from 'node:crypto';

// Groq's OpenAI-compatible API is the only remote destination for assistant
// prompts. API keys and employee data are never sent to the browser.
const BASE_URL = 'https://api.groq.com/openai/v1';
const ENDPOINT = `${BASE_URL}/chat/completions`;
const MODELS_ENDPOINT = `${BASE_URL}/models`;
export const DEFAULT_ASSISTANT_MODEL = 'qwen/qwen3.8-27b';
const safeError = (message, status = 503, retryAfter) => Object.assign(new Error(message), { status, expose: true, retryAfter });

function retryAfterSeconds(value, now) {
    if (!value) return undefined;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds : (Date.parse(value) - now()) / 1000;
    // Never instruct the browser to wait indefinitely on an untrusted header.
    return Number.isFinite(delay) && delay > 0 && delay <= 86_400 ? Math.ceil(delay) : undefined;
}

async function groqRateLimitError(response, now) {
    // Parse only known numeric fields. Never return Groq's raw error message: it
    // may contain account identifiers or fragments of the submitted request.
    const body = await response.json().catch(() => null);
    const detail = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 2000) : '';
    const kind = detail.match(/\((TPM|TPD|RPM|RPD|ITPM|OTPM)\)/i)?.[1]?.toUpperCase();
    const number = name => {
        const match = detail.match(new RegExp(`\\b${name}\\s*:?\\s*~?([0-9,]{1,12})`, 'i'));
        const parsed = Number(match?.[1]?.replaceAll(',', ''));
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    };
    const limit = number('Limit');
    const requested = number('Requested');
    const oversized = /request too large/i.test(detail) ||
        (limit !== undefined && requested !== undefined && requested > limit);
    if (oversized) {
        const size = limit !== undefined && requested !== undefined
            ? ` (المطلوب نحو ${requested.toLocaleString('ar-EG')}، والحد ${limit.toLocaleString('ar-EG')})` : '';
        return safeError(`الطلب نفسه أكبر من الحد المسموح في Groq${size}. ابدئي محادثة جديدة أو قسّمي الطلب إلى رسالتين أقصر؛ الانتظار وحده لن يحل هذا الطلب.`, 429);
    }
    const retryAfter = retryAfterSeconds(response.headers?.get?.('retry-after'), now);
    const period = kind === 'TPD' || kind === 'RPD' ? 'اليومي' : kind === 'TPM' || kind === 'RPM' || kind === 'ITPM' || kind === 'OTPM' ? 'المؤقت' : '';
    const wait = retryAfter ? ` أعيدي المحاولة بعد نحو ${retryAfter < 60 ? `${retryAfter} ثانية` : `${Math.ceil(retryAfter / 60)} دقيقة`}.` : ' أعيدي المحاولة لاحقًا.';
    return safeError(`Groq رفض الطلب بسبب حد الاستخدام ${period} لحسابك. المفتاح الجديد يشترك في حدود الحساب نفسه، فراجعي صفحة Limits في Groq.${wait}`, 429, retryAfter);
}

export function createGroqAssistantProvider({
    model = process.env.GROQ_MODEL || DEFAULT_ASSISTANT_MODEL,
    fetchImpl = (...args) => fetch(...args),
    timeoutMs = 60_000,
    now = () => Date.now(),
} = {}) {
    if (typeof model !== 'string' || !/^[\w./:-]{1,100}$/.test(model)) throw new Error('GROQ_MODEL is invalid.');
    let verified = null;
    return {
        model,
        visionPreflight: true,
        async status(apiKey) {
            if (typeof apiKey !== 'string' || !apiKey) return {
                available: false, provider: 'Groq', vision: true, model,
                message: 'احصلي على مفتاح Groq من console.groq.com/keys ثم احفظيه من الكمبيوتر الأساسي.',
            };
            const fingerprint = createHash('sha256').update(apiKey).digest('hex');
            if (verified?.fingerprint === fingerprint && verified.until > now()) return verified.value;
            try {
                const response = await fetchImpl(MODELS_ENDPOINT, {
                    method: 'GET', headers: { Authorization: `Bearer ${apiKey}` },
                    redirect: 'error',
                    signal: AbortSignal.timeout(Math.min(timeoutMs, 12_000)),
                });
                if ([401, 403].includes(response.status)) return {
                    available: false, provider: 'Groq', vision: true, model,
                    message: 'مفتاح Groq غير صالح أو حسابك غير مسموح له باستخدامه. حدّثيه من الكمبيوتر الأساسي.',
                };
                if (response.status === 429) {
                    const error = await groqRateLimitError(response, now);
                    return { available: false, provider: 'Groq', vision: true, model, message: error.message };
                }
                if (!response.ok) return {
                    available: false, provider: 'Groq', vision: true, model,
                    message: 'تعذر التأكد من اتصال Groq الآن. أعيدي الفحص بعد قليل.',
                };
                const body = await response.json();
                const hasModel = Array.isArray(body?.data) && body.data.some(item => item?.id === model);
                const value = { available: hasModel, provider: 'Groq', vision: true, model,
                    message: hasModel ? 'المساعد جاهز للنص والصور. يمكنكِ بدء المحادثة.' : 'النموذج المحدد غير متاح لحساب Groq حاليًا. راجعي صلاحيات النموذج أو حدّثي البرنامج.' };
                if (hasModel) verified = { fingerprint, until: now() + 60_000, value };
                return value;
            } catch {
                return { available: false, provider: 'Groq', vision: true, model,
                    message: 'تعذر الاتصال بـGroq للتحقق من المفتاح. راجعي الإنترنت ثم أعيدي الفحص.' };
            }
        },
        async chat(messages, tools, apiKey) {
            if (typeof apiKey !== 'string' || !apiKey) throw safeError('اضبط مفتاح المساعد أولًا.');
            const formatted = messages.map(message => {
                if (message.role === 'user' && message.image) {
                    const { mimeType, dataBase64 } = message.image;
                    return { role: 'user', content: [
                        { type: 'text', text: message.content || 'صف محتوى الصورة.' },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${dataBase64}` } },
                    ] };
                }
                return message;
            });
            let response;
            try {
                response = await fetchImpl(ENDPOINT, {
                    method: 'POST',
                    redirect: 'error',
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, messages: formatted,
                        ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
                        temperature: 0.1, max_completion_tokens: 450,
                        ...(model === DEFAULT_ASSISTANT_MODEL ? { reasoning_effort: 'none' } : {}) }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                throw safeError(error?.name === 'TimeoutError' ? 'تأخر رد المساعد. جرّبي مرة أخرى.' : 'تعذر الاتصال بالمساعد. راجعي الإنترنت ثم أعيدي المحاولة.');
            }
            if (!response.ok) {
                if ([401, 403].includes(response.status)) throw safeError('مفتاح Groq غير صالح أو غير مسموح. حدّثيه من الكمبيوتر الأساسي.');
                if (response.status === 429) throw await groqRateLimitError(response, now);
                if (response.status === 404) throw safeError('نموذج المساعد لم يعد متاحًا في Groq. حدّثي البرنامج أو راجعي صلاحيات النموذج.');
                if (response.status === 413) throw safeError('الصورة كبيرة على خدمة المساعد. صغّريها وأعيدي المحاولة.', 413);
                if (response.status === 400) throw safeError('لم يقبل Groq هذا الطلب. جرّبي رسالة أبسط أو صورة أصغر.', 400);
                throw safeError('تعذر تشغيل المساعد الآن. أعيدي المحاولة لاحقًا.');
            }
            const result = await response.json().catch(() => null);
            const message = result?.choices?.[0]?.message;
            if (!message || typeof message !== 'object') throw safeError('استجابة المساعد غير صحيحة. جرّبي مرة أخرى.', 502);
            return message;
        },
    };
}
