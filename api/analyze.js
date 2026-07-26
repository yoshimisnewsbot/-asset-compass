const ALLOWED_CATEGORIES = [
  '現金',
  '日本株',
  '米国株',
  '投資信託',
  '暗号資産',
  '外貨',
  '不動産',
  'RSU・SO',
  'その他'
];

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}

function cleanJson(text = '') {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');

  if (start < 0 || end < start) {
    throw new Error('AI response did not contain JSON');
  }

  return JSON.parse(source.slice(start, end + 1));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'POST only' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return send(res, 500, {
      error: 'GEMINI_API_KEY is not configured'
    });
  }

  try {
    const { images, owner = 'self' } = req.body || {};

    if (!Array.isArray(images) || images.length === 0) {
      return send(res, 400, {
        error: '画像を選択してください'
      });
    }

    if (images.length > 8) {
      return send(res, 400, {
        error: '画像は一度に8枚までです'
      });
    }

    const prompt = `
あなたは日本の個人資産管理アプリの入力補助です。
添付された銀行、証券、暗号資産などのスクリーンショットから、
画面上で確認できる現在評価額・残高だけを抽出してください。

厳守事項:
- 推測しない。読めない値は登録しない。
- 取引履歴、前日比、損益、買付余力と総資産を二重計上しない。
- 同じ口座の複数画面がある場合は重複を避ける。
- value は日本円の整数。
- 円換算額が画面にない外貨だけの場合は value を null にして needsReview を true にする。
- name は金融機関・口座・商品を区別できる短い日本語。
- category は次のいずれか:
  ${ALLOWED_CATEGORIES.join('、')}
- liability は住宅ローン等の負債だけ true。
- confidence は 0〜1。
- owner は必ず "${owner}"。

JSONのみを返してください。

形式:
{
  "assets": [
    {
      "name": "楽天銀行 普通預金",
      "category": "現金",
      "value": 3848007,
      "liability": false,
      "owner": "${owner}",
      "confidence": 0.98,
      "needsReview": false,
      "note": "画面の残高欄"
    }
  ],
  "warnings": [
    "確認事項があれば記載"
  ]
}
`;

    const parts = [{ text: prompt }];

    for (const image of images) {
      if (
        !image ||
        typeof image.data !== 'string' ||
        !image.mimeType
      ) {
        continue;
      }

      parts.push({
        inline_data: {
          mime_type: image.mimeType,
          data: image.data
        }
      });
    }

    if (parts.length === 1) {
      return send(res, 400, {
        error: '有効な画像がありません'
      });
    }

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const raw = await response.json();

    if (!response.ok) {
      console.error('Gemini error', raw);

      return send(res, response.status, {
        error:
          raw?.error?.message ||
          'Gemini API error'
      });
    }

    const text =
      raw?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('') || '';

    const parsed = cleanJson(text);

    const assets = (parsed.assets || [])
      .map((asset) => ({
        name: String(asset.name || '').trim(),
        category: ALLOWED_CATEGORIES.includes(asset.category)
          ? asset.category
          : 'その他',
        value: Number.isFinite(Number(asset.value))
          ? Math.round(Number(asset.value))
          : null,
        liability: Boolean(asset.liability),
        owner,
        confidence: Math.max(
          0,
          Math.min(1, Number(asset.confidence || 0))
        ),
        needsReview:
          Boolean(asset.needsReview) ||
          !Number.isFinite(Number(asset.value)),
        note: String(asset.note || '').slice(0, 200)
      }))
      .filter((asset) => asset.name);

    return send(res, 200, {
      assets,
      warnings: Array.isArray(parsed.warnings)
        ? parsed.warnings
        : []
    });
  } catch (error) {
    console.error(error);

    return send(res, 500, {
      error:
        error.message ||
        '解析に失敗しました'
    });
  }
}
