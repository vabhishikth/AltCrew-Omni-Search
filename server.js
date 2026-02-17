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
You are a search query expansion engine for discovering fitness, sports, wellness, and active lifestyle Instagram accounts.

USER QUERY: "${userQuery}"

YOUR TASK:
1. Extract the CITY/LOCATION from the query.
2. Identify the MAJOR NEIGHBORHOODS/AREAS in that city (e.g., for Bangalore: Indiranagar, HSR Layout, Koramangala, Whitefield, JP Nagar, Jayanagar, Marathahalli, etc.).
3. Generate 20-30 DIVERSE search queries combining BOTH categories AND neighborhoods.

QUERY GENERATION STRATEGY:

A) CATEGORY QUERIES (8-10 queries covering different fitness niches):
   - Running: "run club CityName", "running group CityName", "runners CityName"
   - Yoga/Wellness: "yoga studio CityName", "wellness community CityName"
   - CrossFit/Gym: "crossfit CityName", "fitness club CityName"
   - Sports: "pickleball CityName", "badminton club CityName", "cycling group CityName"
   - Events: "marathon CityName", "fitness event CityName"
   - Abstract names: "fitness crew CityName", "workout tribe CityName"

B) NEIGHBORHOOD QUERIES (8-12 queries targeting specific areas):
   - "run club Neighborhood", "fitness Neighborhood CityName"
   - Target the TOP 6-8 neighborhoods/areas in the city
   - These catch hyper-local clubs like "Indiranagar Run Club" or "HSR Runners"

C) DISCOVERY QUERIES (4-6 queries to find hidden gems):
   - "best fitness communities CityName"
   - "sports clubs near CityName"
   - "active lifestyle CityName Instagram"
   - "fitness influencer CityName" (to find coaches/trainers who lead communities)

RULES:
- Generate 20-30 total queries (this is critical for coverage)
- Each query should be SHORT (2-6 words)
- No duplicates or near-duplicates
- Cover as many different areas and niches as possible

RESPOND WITH ONLY A JSON OBJECT:
{
  "location": "City Name",
  "neighborhoods": ["Area1", "Area2", ...],
  "intent": "brief description of user intent",
  "queries": ["query1", "query2", ...]
}
`;

    try {
        const raw = await callGemini(prompt);
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        console.log(`   ✅ AI generated ${parsed.queries.length} search queries`);
        console.log(`   📍 Location: ${parsed.location}`);
        console.log(`   🏘️  Neighborhoods: ${(parsed.neighborhoods || []).join(', ')}`);
        console.log(`   🎯 Intent: ${parsed.intent}`);
        parsed.queries.forEach((q, i) => console.log(`      ${i + 1}. ${q}`));
        return parsed;
    } catch (err) {
        console.error(`   ❌ Query expansion failed: ${err.message}`);
        const fallbackQueries = [
            userQuery,
            `${userQuery} club`,
            `${userQuery} community`,
            `${userQuery} fitness`,
            `${userQuery} event`,
            `${userQuery} running`,
            `${userQuery} yoga`,
            `${userQuery} sports`,
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
// Two strategies: Instagram-specific + Web-wide discovery
// ═══════════════════════════════════════════════════════════════════════════

// Generic search function — searches Google Custom Search with given query
async function googleSearch(fullQuery, label, pages = 2) {
    const offsets = Array.from({ length: pages }, (_, i) => 1 + (i * 10));

    const pagePromises = offsets.map(async (start) => {
        try {
            const res = await customSearch.cse.list({
                auth: process.env.GOOGLE_SEARCH_API_KEY,
                cx: process.env.GOOGLE_SEARCH_CX,
                q: fullQuery,
                num: 10,
                start: start
            });
            return (res.data.items || []).map(item => ({
                ...item,
                searchQuery: label
            }));
        } catch (e) {
            if (!e.message.includes('429') && !e.message.includes('rateLimitExceeded')) {
                console.error(`      ⚠️ [${label}] page ${start}: ${e.message}`);
            }
            return [];
        }
    });

    const results = await Promise.all(pagePromises);
    return results.flat();
}

// Strategy A: Search Instagram directly
function searchInstagram(query, label) {
    return googleSearch(`site:instagram.com ${query}`, `IG: ${label}`, 2);
}

// Strategy B: Search the open web (finds clubs on blogs, directories, listings)
function searchWeb(query, label) {
    return googleSearch(`${query} instagram`, `WEB: ${label}`, 1);
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

        // ─── PHASE 2: Multi-Query Search (Instagram + Web) ───
        const totalQueries = expansion.queries.length;
        console.log(`\n🔍 PHASE 2: Searching ${totalQueries} queries (Instagram + Web)...`);

        const searchPromises = [];

        // Strategy A: Search Instagram for ALL queries
        expansion.queries.forEach((q, i) => {
            const label = `${q}`;
            console.log(`   📡 IG: ${label}`);
            searchPromises.push(
                searchInstagram(q, label).catch(e => {
                    errors.push(`IG Search [${label}]: ${e.message}`);
                    return [];
                })
            );
        });

        // Strategy B: Web-wide search for top 5 category queries (to find clubs listed elsewhere)
        const webQueries = expansion.queries.slice(0, 5);
        webQueries.forEach((q, i) => {
            const label = `${q}`;
            console.log(`   🌐 WEB: ${label}`);
            searchPromises.push(
                searchWeb(q, label).catch(e => {
                    errors.push(`Web Search [${label}]: ${e.message}`);
                    return [];
                })
            );
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
