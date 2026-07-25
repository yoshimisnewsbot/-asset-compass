(() => {
  const $ = id => document.getElementById(id);
  const ownerNames = { self: '自分', spouse: '奥さん', shared: '共通資産' };
  const yen = n => new Intl.NumberFormat('ja-JP', {
    style: 'currency', currency: 'JPY', maximumFractionDigits: 0
  }).format(Number(n || 0));

  let selectedFiles = [];
  let analysisResult = null;

  const style = document.createElement('style');
  style.textContent = `
    .ai-result{margin-top:14px;padding:14px;border:1px solid #e5e7eb;border-radius:14px;background:#fff}
    .ai-result-row{padding:12px 0;border-bottom:1px solid #eef2f7}
    .ai-result-row:last-child{border-bottom:0}
    .ai-result-row label{margin:8px 0}
    .ai-result-grid{display:grid;grid-template-columns:1fr 130px;gap:8px}
    .ai-confidence{font-size:11px;color:#6b7280}
    .ai-warning{padding:10px;border-radius:10px;background:#fff7ed;color:#9a3412;font-size:12px;margin:8px 0}
    .ai-spinner{display:inline-block;width:15px;height:15px;border:2px solid #d1d5db;border-top-color:#111827;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:7px}
    @keyframes spin{to{transform:rotate(360deg)}}
    button:disabled{opacity:.55}
  `;
  document.head.appendChild(style);

  const section = $('analyzeBtn')?.closest('section');
  if (!section) return;

  let resultBox = document.createElement('div');
  resultBox.id = 'aiResultBox';
  resultBox.className = 'ai-result hidden';
  section.appendChild(resultBox);

  const help = section.querySelector('.upload-box .muted');
  if (help) help.textContent = '画像は送信前に端末内で縮小し、Geminiで残高を解析します。結果を確認してから反映します。';
  if ($('analyzeNote')) $('analyzeNote').textContent = '無料枠のGemini APIで解析します。APIキーはVercel内に安全に保管されています。';

  function fileToCompressedImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('画像形式を読み込めませんでした'));
        img.onload = () => {
          const maxSide = 1600;
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
          resolve({ mimeType: 'image/jpeg', data: dataUrl.split(',')[1] });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function normalizeName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function renderReview(data) {
    analysisResult = data;
    resultBox.classList.remove('hidden');

    const warnings = (data.warnings || []).map(w =>
      `<div class="ai-warning">⚠️ ${String(w).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</div>`
    ).join('');

    const rows = (data.assets || []).map((a, i) => `
      <div class="ai-result-row" data-index="${i}">
        <label class="check"><input type="checkbox" class="ai-use" checked>この項目を反映</label>
        <label>名称<input class="ai-name" value="${String(a.name || '').replace(/"/g, '&quot;')}"></label>
        <div class="ai-result-grid">
          <label>分類
            <select class="ai-category">
              ${['現金','日本株','米国株','投資信託','暗号資産','外貨','不動産','RSU・SO','その他']
                .map(c => `<option ${c === a.category ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </label>
          <label>評価額（円）<input class="ai-value" type="number" min="0" value="${a.value ?? ''}"></label>
        </div>
        <label class="check"><input type="checkbox" class="ai-liability" ${a.liability ? 'checked' : ''}>負債</label>
        <div class="ai-confidence">AI確信度 ${Math.round((a.confidence || 0) * 100)}%${a.note ? ` ・ ${a.note}` : ''}${a.needsReview ? ' ・ 要確認' : ''}</div>
      </div>
    `).join('');

    resultBox.innerHTML = `
      <h3>解析結果を確認</h3>
      <p class="muted">金額・名称を確認してください。同名の既存資産は更新し、それ以外は追加します。</p>
      ${warnings}
      ${rows || '<div class="empty">資産額を読み取れませんでした。別のスクショで試してください。</div>'}
      ${rows ? '<div class="actions" style="margin-top:12px"><button id="applyAiBtn" class="primary wide">確認した内容を反映</button><button id="cancelAiBtn" class="secondary">取消</button></div>' : ''}
    `;

    $('cancelAiBtn')?.addEventListener('click', () => {
      resultBox.classList.add('hidden');
      resultBox.innerHTML = '';
      analysisResult = null;
    });

    $('applyAiBtn')?.addEventListener('click', applyResults);
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function applyResults() {
    const owner = $('uploadOwner').value;
    const rows = [...resultBox.querySelectorAll('.ai-result-row')];
    const chosen = rows.map(row => ({
      use: row.querySelector('.ai-use').checked,
      name: row.querySelector('.ai-name').value.trim(),
      category: row.querySelector('.ai-category').value,
      value: Number(row.querySelector('.ai-value').value),
      liability: row.querySelector('.ai-liability').checked,
      owner
    })).filter(a => a.use && a.name && Number.isFinite(a.value) && a.value >= 0);

    if (!chosen.length) {
      alert('反映する項目がありません。金額を確認してください。');
      return;
    }

    if (typeof state === 'undefined' || !Array.isArray(state.assets)) {
      alert('Asset Compassのデータを取得できませんでした。');
      return;
    }

    for (const item of chosen) {
      const existing = state.assets.find(a =>
        a.owner === item.owner && normalizeName(a.name) === normalizeName(item.name)
      );
      if (existing) {
        existing.category = item.category;
        existing.value = item.value;
        existing.liability = item.liability;
      } else {
        state.assets.push({
          id: typeof uid === 'function' ? uid() : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          ...item
        });
      }
    }

    if (typeof save === 'function') save();
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '';
    analysisResult = null;
    selectedFiles = [];
    $('screenshotInput').value = '';
    $('thumbs').innerHTML = '';
    $('analyzeNote').textContent = `${chosen.length}件を反映しました。`;
    alert(`${chosen.length}件の資産を更新しました`);
  }

  $('screenshotInput').addEventListener('change', e => {
    selectedFiles = [...e.target.files].slice(0, 8);
  });

  $('analyzeBtn').onclick = async () => {
    if (!selectedFiles.length) {
      alert('先にスクショを選択してください。');
      return;
    }

    const btn = $('analyzeBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="ai-spinner"></span>画像を解析中';
    $('analyzeNote').textContent = '画像を縮小してGeminiに送信しています。少し待ってください。';
    resultBox.classList.add('hidden');

    try {
      const images = [];
      for (const file of selectedFiles) images.push(await fileToCompressedImage(file));

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, owner: $('uploadOwner').value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `解析エラー（${response.status}）`);

      $('analyzeNote').textContent = `${ownerNames[$('uploadOwner').value]}の資産候補を${data.assets?.length || 0}件抽出しました。`;
      renderReview(data);
    } catch (error) {
      console.error(error);
      $('analyzeNote').textContent = '解析に失敗しました。';
      alert(`解析できませんでした。\n${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'AI解析を開始';
    }
  };
})();
