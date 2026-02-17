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
const customSearch = google.customsearch('v1');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PRIMARY_MODEL = 'gemini-2.0-flash';
const FALLBACK_MODEL = 'gemini-1.5-flash';

// ═══════════════════════════════════════════════════════════════════════════
// 🏥 HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
    const env = {
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        GOOGLE_SEARCH_API_KEY: !!process.env.GOOGLE_SEARCH_API_KEY,
        GOOGLE_SEARCH_CX: !!process.env.GOOGLE_SEARCH_CX,
    };
    const allSet = Object.values(env).every(v => v);
    res.json({
        status: allSet ? 'healthy' : 'misconfigured',
        environment: env,
        message: allSet
            ? 'All environment variables are set.'
            : 'MISSING environment variables! Set them in Render Dashboard > Settings > Environment Variables.'
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🤖 GEMINI HELPER — Call with Fallback
// ═══════════════════════════════════════════════════════════════════════════
async function callGemini(prompt) {
    async function tryModel(modelName) {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    try {
        return await tryModel(PRIMARY_MODEL);
    } catch (e1) {
        console.log(`   ⚠️ Primary model failed (${e1.message}), trying fallback...`);
        try {
            return await tryModel(FALLBACK_MODEL);
        } catch (e2) {
            throw new Error(`Both models failed. Primary: ${e1.message} | Fallback: ${e2.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🧠 PHASE 1: AI QUERY EXPANSION
// Takes a natural language query and generates diverse search terms
// ═══════════════════════════════════════════════════════════════════════════
async function expandQuery(userQuery) {
    console.log(`\n🧠 PHASE 1: Expanding query with AI...`);

    const prompt = `
You are a search query expansion engine for discovering fitness, sports, wellness, and active lifestyle communities on Instagram.

USER QUERY: "${userQuery}"

YOUR TASK:
1. Extract the CITY/LOCATION from the query (if not specified, use "India").
2. Understand the user's INTENT — what types of communities/clubs/events they want.
3. Generate 10-15 DIVERSE search queries that will find ALL related Instagram profiles.

IMPORTANT RULES:
- Each query should target a DIFFERENT category/niche (running, yoga, cycling, CrossFit, pickleball, martial arts, dance fitness, swimming, hiking, wellness, meditation, calisthenics, etc.)
- Include queries for EVENTS (marathons, tournaments, expos, workshops)
- Include queries for abstract/vibe community names (crews, collectives, squads, scenes, tribes)
- Keep each query SHORT (2-5 words + city name)
- Do NOT repeat the same concept in different phrasings

RESPOND WITH ONLY A JSON OBJECT:
{
  "location": "City Name",
  "intent": "brief description of user intent",
  "queries": [
    "run club CityName",
    "yoga community CityName",
    "CrossFit box CityName",
    "cycling group CityName",
    ...
  ]
}
`;

    try {
        const raw = await callGemini(prompt);
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        console.log(`   ✅ AI generated ${parsed.queries.length} search queries`);
        console.log(`   📍 Location: ${parsed.location}`);
        console.log(`   🎯 Intent: ${parsed.intent}`);
        parsed.queries.forEach((q, i) => console.log(`      ${i + 1}. ${q}`));
        return parsed;
    } catch (err) {
        console.error(`   ❌ Query expansion failed: ${err.message}`);
        // Fallback: use the raw query with default expansions
        const fallbackQueries = [
            userQuery,
            `${userQuery} club`,
            `${userQuery} community`,
            `${userQuery} fitness`,
            `${userQuery} event`,
            `${userQuery} academy`,
        ];
        return {
            location: 'Unknown',
            intent: userQuery,
            queries: fallbackQueries,
            fallback: true
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔍 PHASE 2: MULTI-QUERY SEARCH
// Searches each AI-generated query on Instagram via Google Custom Search
// ═══════════════════════════════════════════════════════════════════════════
const PAGES_PER_QUERY = 2; // 20 results per query

async function searchInstagram(query, queryLabel) {
    const searchQuery = `site:instagram.com ${query}`;
    const offsets = Array.from({ length: PAGES_PER_QUERY }, (_, i) => 1 + (i * 10));

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
                searchQuery: queryLabel
            }));
        } catch (e) {
            // Don't log quota errors for every page — too noisy
            if (!e.message.includes('429') && !e.message.includes('rateLimitExceeded')) {
                console.error(`      ⚠️ [${queryLabel}] page ${start}: ${e.message}`);
            }
            return [];
        }
    });

    const results = await Promise.all(pagePromises);
    return results.flat();
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 PHASE 3: AI CLASSIFICATION
// Uses Gemini to classify and filter results intelligently
// ═══════════════════════════════════════════════════════════════════════════
async function classifyResults(candidates, userQuery, location) {
    const BATCH_SIZE = 40;
    const batches = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    console.log(`\n🎯 PHASE 3: AI Classification (${candidates.length} candidates in ${batches.length} batches)...`);

    const batchPromises = batches.map(async (batch, index) => {
        const prompt = `
You are the "Omni-Search Intelligence" classifier for fitness & wellness communities.

USER QUERY: "${userQuery}"
TARGET LOCATION: "${location}"

INSTRUCTIONS:
1. Analyze each Instagram profile result below.
2. Determine if it is a REAL fitness/wellness/sports entity (club, community, studio, event, brand, coach).
3. CLASSIFY into one of: "Run Club", "Fitness Club", "Sports Club", "Yoga/Wellness", "Event", "Hybrid Studio", "Community", "Coach/Trainer", "Brand".
4. EXTRACT the follower count from 'ogDescription' (e.g., "12.5K Followers" → "12.5k").
5. Write a SHORT reasoning (3-5 words) for why it matched.

CRITICAL RULES:
- DO NOT judge by name alone! A club called "Daa Scene" or "Hyfit" or "The Tribe" IS valid if their bio/description mentions fitness, running, wellness, yoga, sports, or similar activities.
- Look at the BIO/DESCRIPTION content to determine relevance, not just the name.
- REJECT only if the profile is clearly a personal account with no fitness/community activity.
- REJECT profiles that are clearly in a different city/country (unless the city isn't specified).
- BE INCLUSIVE — when in doubt, INCLUDE the result.

INPUT DATA:
${JSON.stringify(batch, null, 2)}

RESPOND WITH ONLY A JSON ARRAY:
[
  {
    "name": "Display Name",
    "handle": "@instagram_handle",
    "category": "Run Club",
    "subcategory": "Running",
    "followers": "12k",
    "logo": "url_from_input_or_null",
    "reasoning": "Active run club in city",
    "url": "https://instagram.com/..."
  }
]

If NO results are valid, respond with: []
`;

        try {
            const raw = await callGemini(prompt);
            const clean = raw.replace(/```json|```/g, '').trim();
            return JSON.parse(clean);
        } catch (err) {
            console.error(`      ❌ Classification batch ${index + 1} failed: ${err.message}`);
            return [];
        }
    });

    const batchResults = await Promise.all(batchPromises);
    return batchResults.flat();
}

// ═══════════════════════════════════════════════════════════════════════════
// 🚀 MAIN API ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/omni-search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query required" });

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`🔍 OMNI-SEARCH: "${query}"`);
        console.log('═'.repeat(60));

        const errors = [];
        const startTime = Date.now();

        // ─── PHASE 1: AI Query Expansion ───
        let expansion;
        try {
            expansion = await expandQuery(query);
        } catch (e) {
            errors.push(`Query Expansion: ${e.message}`);
            expansion = { location: 'Unknown', intent: query, queries: [query], fallback: true };
        }

        // ─── PHASE 2: Multi-Query Search ───
        console.log(`\n🔍 PHASE 2: Searching ${expansion.queries.length} queries across Instagram...`);

        const searchPromises = expansion.queries.map((q, i) => {
            const label = `Q${i + 1}: ${q}`;
            console.log(`   📡 ${label}`);
            return searchInstagram(q, label).catch(e => {
                errors.push(`Search [${label}]: ${e.message}`);
                return [];
            });
        });

        const searchResults = await Promise.all(searchPromises);

        // Flatten and Deduplicate
        const allItems = searchResults.flat();
        const seenUrls = new Set();
        const uniqueItems = [];

        for (const item of allItems) {
            if (!seenUrls.has(item.link)) {
                seenUrls.add(item.link);

                const metatags = item.pagemap?.metatags?.[0] || {};
                const cseImage = item.pagemap?.cse_image?.[0]?.src || null;

                uniqueItems.push({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                    ogDescription: metatags['og:description'] || '',
                    logoUrl: metatags['og:image'] || cseImage,
                    sourceQuery: item.searchQuery
                });
            }
        }

        console.log(`   ✅ ${allItems.length} raw → ${uniqueItems.length} unique candidates`);
        console.log(`   ⏱️ Search time: ${Date.now() - startTime}ms`);

        if (uniqueItems.length === 0) {
            return res.json({
                results: [],
                meta: {
                    query,
                    candidates_scanned: 0,
                    queries_used: expansion.queries.length,
                    location: expansion.location,
                    intent: expansion.intent,
                    expanded_queries: expansion.queries
                },
                debug: {
                    message: 'Google Custom Search returned 0 results across all queries.',
                    errors: errors.length > 0 ? errors : ['All queries returned empty — check API key, CX, or quota.'],
                    env_check: {
                        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
                        GOOGLE_SEARCH_API_KEY: !!process.env.GOOGLE_SEARCH_API_KEY,
                        GOOGLE_SEARCH_CX: !!process.env.GOOGLE_SEARCH_CX
                    }
                }
            });
        }

        // ─── PHASE 3: AI Classification ───
        let validResults = await classifyResults(uniqueItems, query, expansion.location);

        // Re-attach high-res logos
        validResults = validResults.map(r => {
            const original = uniqueItems.find(u =>
                u.link === r.url || u.link.includes(r.handle?.replace('@', ''))
            );
            return {
                ...r,
                logo: r.logo || original?.logoUrl || null,
                sourceQuery: original?.sourceQuery || 'Unknown'
            };
        });

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✨ COMPLETE: ${validResults.length} entities found in ${totalTime}s`);

        res.json({
            meta: {
                query,
                candidates_scanned: uniqueItems.length,
                queries_used: expansion.queries.length,
                location: expansion.location,
                intent: expansion.intent,
                expanded_queries: expansion.queries,
                time_seconds: parseFloat(totalTime)
            },
            results: validResults,
            debug: errors.length > 0 ? { errors } : undefined
        });

    } catch (error) {
        console.error("   ❌ Critical Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n🚀 OMNI-SEARCH ENGINE v2.0 ACTIVE ON PORT ${PORT}`);
    console.log(`   Powered by Gemini 2.0 Flash + AI Query Expansion`);
});
