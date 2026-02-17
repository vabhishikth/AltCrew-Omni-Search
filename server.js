require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

// Initialize App
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const PORT = process.env.PORT || 3000;
const PAGINATION_PAGES = 4; // Fetch top 40 results per layer (4 pages)
const customSearch = google.customsearch('v1');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Model Strategy: Best Reasoning (Primary) -> Newest Flash (Fallback)
const PRIMARY_MODEL = 'gemini-1.5-pro';
const FALLBACK_MODEL = 'gemini-2.0-flash-exp';

// ═══════════════════════════════════════════════════════════════════════════
// 🔍 MASTER OMNI-SEARCH LAYERS
// ═══════════════════════════════════════════════════════════════════════════
const SEARCH_LAYERS = [
    { name: 'Standard', suffix: '' },
    { name: 'Community', suffix: ' ("Community" OR "Family" OR "Society" OR "Tribe")' },
    { name: 'Abstract', suffix: ' ("Crew" OR "Squad" OR "Collective" OR "Scene" OR "Movement" OR "Gang")' },
    { name: 'Sports', suffix: ' ("League" OR "Academy" OR "Arena" OR "Turf" OR "Court" OR "Gymkhana")' },
    { name: 'Event', suffix: ' ("Event" OR "Marathon" OR "Tournament" OR "Expo" OR "Workshop" OR "Challenge")' },
    { name: 'Hybrid', suffix: ' ("Hybrid" OR "Studio" OR "Lab" OR "Box" OR "Wellness" OR "FitnessClub" OR "Performance")' }
];

// Helper: Fetch Search Results for a specific layer (Deep Search)
async function fetchLayer(query, layer) {
    const searchQuery = `site:instagram.com ${query} ${layer.suffix}`.trim();
    console.log(`   📡 Layer [${layer.name}]: Deep Searching (${PAGINATION_PAGES} pages)...`);

    // Create offsets [1, 11, 21, ...]
    const offsets = Array.from({ length: PAGINATION_PAGES }, (_, i) => 1 + (i * 10));

    const pagePromises = offsets.map(async (start) => {
        try {
            const res = await customSearch.cse.list({
                auth: process.env.GOOGLE_SEARCH_API_KEY,
                cx: process.env.GOOGLE_SEARCH_CX,
                q: searchQuery,
                num: 10,
                start: start
            });
            return (res.data.items || []).map(item => ({
                ...item,
                searchLayer: layer.name // Tag result with source layer
            }));
        } catch (e) {
            console.error(`      ⚠️ Layer [${layer.name}] Page ${start} Limit/Error: ${e.message}`);
            return [];
        }
    });

    const results = await Promise.all(pagePromises);
    return results.flat();
}

// Helper: Call Gemini with Fallback
async function analyzeWithGemini(prompt) {
    async function tryModel(modelName) {
        try {
            console.log(`   🤖 Asking ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (e) {
            throw new Error(`${modelName} failed: ${e.message}`);
        }
    }

    try {
        return await tryModel(PRIMARY_MODEL);
    } catch (e1) {
        console.log(`   ⚠️ Primary failed, trying fallback...`);
        return await tryModel(FALLBACK_MODEL);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🚀 API ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/omni-search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query required" });

        console.log(`\n🔍 OMNI-SEARCH: "${query}"`);
        console.log('════════════════════════════════════════════════════');

        // 1. EXECUTE PARALLEL SEARCH LAYERS
        const start = Date.now();
        const layerPromises = SEARCH_LAYERS.map(layer => fetchLayer(query, layer));
        const layerResults = await Promise.all(layerPromises);

        // Flatten and Deduplicate
        const allItems = layerResults.flat();
        const seenUrls = new Set();
        const uniqueItems = [];

        for (const item of allItems) {
            if (!seenUrls.has(item.link)) {
                seenUrls.add(item.link);

                // Extract Metadata from Pagemap
                const metatags = item.pagemap?.metatags?.[0] || {};
                const cseImage = item.pagemap?.cse_image?.[0]?.src || null;

                uniqueItems.push({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                    ogDescription: metatags['og:description'] || '',
                    logoUrl: metatags['og:image'] || cseImage,
                    layer: item.searchLayer
                });
            }
        }

        console.log(`   ✅ Fetched ${allItems.length} raw results -> ${uniqueItems.length} unique candidates`);
        console.log(`   ⏱️  Time: ${Date.now() - start}ms`);

        if (uniqueItems.length === 0) return res.json({ results: [] });

        // 2. AI ANALYSIS (BATCHED)
        const BATCH_SIZE = 50;
        const batches = [];
        for (let i = 0; i < uniqueItems.length; i += BATCH_SIZE) {
            batches.push(uniqueItems.slice(i, i + BATCH_SIZE));
        }

        console.log(`   🧠 Processing ${uniqueItems.length} candidates in ${batches.length} AI batches...`);

        const aiPromises = batches.map(async (batch, index) => {
            const prompt = `
You are the "Omni-Search Intelligence" API.
Your goal is to identify ALL valid fitness entities from the search results below.

USER QUERY: "${query}"

INSTRUCTIONS:
1. Analyze each result to check if it matches the user's intent.
2. CLASSIFY into one of: "Club", "Sports Facility", "Event", "Hybrid Studio", "Community".
3. EXTRACT the exact Follower Count (e.g., "12.5k", "800") from the 'ogDescription' or text.
4. REASONING: Write a very short (3-5 words) explanation of why it matched.
5. STRICTNESS:
   - REJECT random personal profiles unless they are clearly a "Coach" or "Brand".
   - REJECT completely unrelated pages.
   - BE "OPEN MINDED" about names: Accept abstract/vibe names like "Daa Scene", "The Tribe", "Hyfit".

INPUT DATA:
${JSON.stringify(batch, null, 2)}

RESPONSE FORMAT (JSON Array ONLY):
[
  {
    "name": "Club Name",
    "handle": "@handle",
    "category": "Club",
    "followers": "12k",
    "logo": "url_from_input_if_valid_otherwise_null",
    "reasoning": "Explicit run club match",
    "url": "https://instagram.com/..."
  }
]
`;
            try {
                const raw = await analyzeWithGemini(prompt);
                const clean = raw.replace(/```json|```/g, '').trim();
                return JSON.parse(clean);
            } catch (err) {
                console.error(`      ❌ Batch ${index + 1} Failed:`, err.message);
                return [];
            }
        });

        const batchResults = await Promise.all(aiPromises);
        let validResults = batchResults.flat();

        // Re-attach high-res logos (Post-Process)
        validResults = validResults.map(r => {
            const original = uniqueItems.find(u => u.link === r.url || u.link.includes(r.handle?.replace('@', '')));
            return {
                ...r,
                logo: r.logo || original?.logoUrl || null,
                layer: original?.layer || 'Unknown'
            };
        });

        console.log(`   ✨ AI Identified ${validResults.length} valid entities`);

        res.json({
            meta: {
                query,
                candidates_scanned: uniqueItems.length,
                layers_used: SEARCH_LAYERS.length
            },
            results: validResults
        });

    } catch (error) {
        console.error("   ❌ Critical Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n🚀 MASTER OMNI-SEARCH ENGINE ACTIVE ON PORT ${PORT}`);
    console.log(`   Powered by Gemini 1.5 Pro & Parallel Search Layers`);
});
