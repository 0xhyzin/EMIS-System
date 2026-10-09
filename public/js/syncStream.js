export async function consumeSyncStream(response, onEvent) {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'تعذر بدء المزامنة. حاول مرة أخرى.');
  }
  if (!response.body) throw new Error('المتصفح لم يستقبل بيانات المزامنة.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', terminal = false;
  async function accept(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const event = JSON.parse(data);
    if (event.step === 'done' || event.step === 'error') terminal = true;
    await onEvent(event);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replace(/\r\n/g, '\n');
      let index;
      while ((index = pending.indexOf('\n\n')) !== -1) {
        await accept(pending.slice(0, index)); pending = pending.slice(index + 2);
      }
      if (done) break;
    }
    if (pending.trim()) await accept(pending);
    if (!terminal) throw new Error('انقطع الاتصال قبل تأكيد نتيجة المزامنة.');
  } finally { reader.releaseLock(); }
}
