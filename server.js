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
// Generates comprehensive search queries across categories, neighborhoods,
// popular accounts, hashtags, and discovery patterns
// ═══════════════════════════════════════════════════════════════════════════
async function expandQuery(userQuery) {
    console.log(`\n🧠 PHASE 1: Expanding query with AI...`);

    const prompt = `
You are an expert search query generator. Your job is to generate the MOST COMPREHENSIVE set of Google search queries possible to discover ALL fitness, wellness, sports, and active lifestyle communities/clubs/events in a city.

USER QUERY: "${userQuery}"

CRITICAL: Even if the user mentions only ONE category (e.g., "run clubs"), you MUST STILL generate queries for ALL fitness/wellness/sports categories. The user wants to discover the ENTIRE fitness ecosystem in that city. "Run clubs in Bangalore" means "show me run clubs, cycling groups, yoga studios, CrossFit boxes, pickleball crews, dance fitness, martial arts, wellness communities, fitness brands, coaches, AND everything else in Bangalore." Always treat ANY fitness-related query as a request for the FULL spectrum of active lifestyle communities.

GENERATE QUERIES IN THESE CATEGORIES:

A) DIRECT CATEGORY SEARCHES (10-12 queries):
   Cover EVERY fitness niche — running, cycling, yoga, CrossFit, calisthenics, swimming, hiking, trekking, martial arts, boxing, dance fitness, Zumba, pickleball, badminton, tennis, football, basketball, ultimate frisbee, bouldering, climbing, skateboarding, surfing, etc.
   Format: "category CityName" or "category club CityName"

B) NEIGHBORHOOD/AREA SPECIFIC (8-10 queries):
   Generate queries for the most popular neighborhoods in the city.
   Format: "run club NeighborhoodName" or "fitness NeighborhoodName CityName"

C) LISTICLE & DIRECTORY DISCOVERY (6-8 queries):
   These find blog posts and articles that LIST many clubs at once:
   - "best fitness clubs in CityName"
   - "top run clubs CityName 2024"
   - "fitness communities in CityName list"
   - "workout groups CityName reddit"
   - "CityName fitness Instagram accounts to follow"
   - "sports clubs in CityName directory"

D) HASHTAG & SOCIAL DISCOVERY (4-6 queries):
   - "#CityNamefitness Instagram"
   - "#CityNamerunners"
   - "CityName fitness influencer"
   - "CityName wellness coach"

E) POPULAR & WELL-KNOWN ACCOUNTS (4-6 queries):
   - "most popular fitness pages CityName Instagram"
   - "famous run clubs CityName"
   - "trending fitness CityName"

RULES:
- Generate 30-40 total queries (MORE IS BETTER for coverage)
- Each query should be SHORT (2-6 words)
- Cover as many different sports and activities as possible
- Mix specific (e.g., "CrossFit Indiranagar") with broad (e.g., "fitness community Bangalore")
- Include both English and any locally relevant language terms

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
            `best fitness clubs ${userQuery}`,
            `top run clubs ${userQuery}`,
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
// Three strategies: Instagram direct, Web discovery, Listicle mining
// ═══════════════════════════════════════════════════════════════════════════

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

// Strategy A: Search Instagram directly (3 pages = 30 results per query)
function searchInstagram(query, label) {
    return googleSearch(`site:instagram.com ${query}`, `IG: ${label}`, 3);
}

// Strategy B: Search the open web (2 pages = 20 results — finds blogs, directories, listings)
function searchWeb(query, label) {
    return googleSearch(`${query} instagram`, `WEB: ${label}`, 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 PHASE 3: AI CLASSIFICATION
// Two-stage: classify Instagram profiles + extract handles from web pages
// ═══════════════════════════════════════════════════════════════════════════

// Stage A: Classify direct Instagram results
async function classifyInstagramResults(candidates, userQuery, location) {
    const BATCH_SIZE = 40;
    const batches = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    console.log(`   📋 Classifying ${candidates.length} Instagram candidates (${batches.length} batches)...`);

    const batchPromises = batches.map(async (batch, index) => {
        const prompt = `
You are the "Omni-Search Intelligence" classifier for fitness & wellness communities.

USER QUERY: "${userQuery}"
TARGET LOCATION: "${location}"

INSTRUCTIONS:
1. Analyze each result below.
2. Determine if it is a REAL fitness/wellness/sports entity.
3. CLASSIFY into: "Run Club", "Fitness Club", "Sports Club", "Yoga/Wellness", "Event", "Hybrid Studio", "Community", "Coach/Trainer", "Brand".
4. EXTRACT the follower count from 'ogDescription' (e.g., "12.5K Followers" → "12.5k").
5. Write a SHORT reasoning (3-5 words).

CRITICAL RULES:
- DO NOT judge by name alone! Abstract names like "Daa Scene", "Hyfit", "The Tribe", "Soul Mates" ARE valid if their description hints at fitness/wellness/sports.
- Look at the BIO/DESCRIPTION/SNIPPET to determine relevance.
- REJECT only if clearly a personal account with no fitness/community activity.
- REJECT profiles clearly in a different city (unless city is unspecified).
- BE VERY INCLUSIVE — when in doubt, INCLUDE the result. It's better to include an extra result than to miss a real club.

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
            console.error(`      ❌ IG Classification batch ${index + 1} failed: ${err.message}`);
            return [];
        }
    });

    const batchResults = await Promise.all(batchPromises);
    return batchResults.flat();
}

// Stage B: Extract Instagram handles from web pages (blogs, directories, articles)
async function extractFromWebResults(candidates, userQuery, location) {
    if (candidates.length === 0) return [];

    const BATCH_SIZE = 30;
    const batches = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    console.log(`   🌐 Mining ${candidates.length} web results for Instagram handles (${batches.length} batches)...`);

    const batchPromises = batches.map(async (batch, index) => {
        const prompt = `
You are an Instagram handle extractor. Your job is to find ALL fitness/wellness/sports Instagram accounts mentioned in web pages.

USER QUERY: "${userQuery}"
TARGET LOCATION: "${location}"

These are web search results (blog posts, directories, articles, listings). They often contain lists of fitness clubs, communities, and events with their Instagram handles.

INSTRUCTIONS:
1. Read each result's title, snippet, and description.
2. Extract EVERY Instagram handle or account name mentioned that relates to fitness/wellness/sports in ${location}.
3. If a snippet mentions "follow @someclub on Instagram" or lists accounts, extract ALL of them.
4. If the result is an article like "10 Best Run Clubs in ${location}", try to identify all clubs mentioned.
5. Even if you can't find the exact handle, provide the club NAME if clearly mentioned.

INPUT DATA:
${JSON.stringify(batch, null, 2)}

RESPOND WITH ONLY A JSON ARRAY of accounts found:
[
  {
    "name": "Club Name",
    "handle": "@handle_if_found_or_null",
    "category": "Run Club",
    "subcategory": "Running",
    "followers": null,
    "logo": null,
    "reasoning": "Mentioned in listicle article",
    "url": "https://instagram.com/handle_if_known",
    "source": "extracted from web"
  }
]

If no accounts found, respond with: []
`;

        try {
            const raw = await callGemini(prompt);
            const clean = raw.replace(/```json|```/g, '').trim();
            return JSON.parse(clean);
        } catch (err) {
            console.error(`      ❌ Web extraction batch ${index + 1} failed: ${err.message}`);
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
        console.log(`\n🔍 PHASE 2: Searching ${totalQueries} queries (IG + Web)...`);

        const igPromises = [];
        const webPromises = [];

        // ALL queries search Instagram (3 pages each)
        expansion.queries.forEach((q) => {
            console.log(`   📡 IG: ${q}`);
            igPromises.push(
                searchInstagram(q, q).catch(e => {
                    errors.push(`IG [${q}]: ${e.message}`);
                    return [];
                })
            );
        });

        // ALL queries ALSO search the web (2 pages each)
        expansion.queries.forEach((q) => {
            console.log(`   🌐 WEB: ${q}`);
            webPromises.push(
                searchWeb(q, q).catch(e => {
                    errors.push(`WEB [${q}]: ${e.message}`);
                    return [];
                })
            );
        });

        // Execute all searches in parallel
        const [igResults, webResults] = await Promise.all([
            Promise.all(igPromises),
            Promise.all(webPromises)
        ]);

        // Separate Instagram vs Web results for different classification
        const allIgItems = igResults.flat();
        const allWebItems = webResults.flat();

        // Deduplicate Instagram results
        const seenUrls = new Set();
        const uniqueIgItems = [];
        for (const item of allIgItems) {
            if (!seenUrls.has(item.link)) {
                seenUrls.add(item.link);
                const metatags = item.pagemap?.metatags?.[0] || {};
                const cseImage = item.pagemap?.cse_image?.[0]?.src || null;
                uniqueIgItems.push({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                    ogDescription: metatags['og:description'] || '',
                    logoUrl: metatags['og:image'] || cseImage,
                    sourceQuery: item.searchQuery
                });
            }
        }

        // Deduplicate Web results (exclude Instagram URLs already captured)
        const uniqueWebItems = [];
        for (const item of allWebItems) {
            if (!seenUrls.has(item.link)) {
                seenUrls.add(item.link);
                const metatags = item.pagemap?.metatags?.[0] || {};
                uniqueWebItems.push({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                    ogDescription: metatags['og:description'] || '',
                    sourceQuery: item.searchQuery
                });
            }
        }

        const totalCandidates = uniqueIgItems.length + uniqueWebItems.length;
        console.log(`   ✅ ${allIgItems.length} IG raw → ${uniqueIgItems.length} unique IG profiles`);
        console.log(`   ✅ ${allWebItems.length} Web raw → ${uniqueWebItems.length} unique web pages`);
        console.log(`   📊 Total unique candidates: ${totalCandidates}`);
        console.log(`   ⏱️ Search time: ${Date.now() - startTime}ms`);

        if (totalCandidates === 0) {
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

        // ─── PHASE 3: AI Classification (two-stage) ───
        console.log(`\n🎯 PHASE 3: AI Classification...`);

        // Run both classification stages in parallel
        const [igClassified, webExtracted] = await Promise.all([
            classifyInstagramResults(uniqueIgItems, query, expansion.location),
            extractFromWebResults(uniqueWebItems, query, expansion.location)
        ]);

        console.log(`   ✅ IG classified: ${igClassified.length} entities`);
        console.log(`   ✅ Web extracted: ${webExtracted.length} entities`);

        // Merge and deduplicate results from both sources
        const mergedResults = [...igClassified];
        const seenHandles = new Set(igClassified.map(r => r.handle?.toLowerCase()).filter(Boolean));

        for (const webResult of webExtracted) {
            const handle = webResult.handle?.toLowerCase();
            if (handle && !seenHandles.has(handle)) {
                seenHandles.add(handle);
                mergedResults.push(webResult);
            } else if (!handle && webResult.name) {
                // Include named results without handles (they have the club name at least)
                const nameKey = webResult.name.toLowerCase();
                if (!mergedResults.some(r => r.name.toLowerCase() === nameKey)) {
                    mergedResults.push(webResult);
                }
            }
        }

        // Re-attach high-res logos for IG results
        const finalResults = mergedResults.map(r => {
            const original = uniqueIgItems.find(u =>
                u.link === r.url || u.link.includes(r.handle?.replace('@', ''))
            );
            return {
                ...r,
                logo: r.logo || original?.logoUrl || null,
                sourceQuery: r.sourceQuery || original?.sourceQuery || 'Discovery'
            };
        });

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✨ COMPLETE: ${finalResults.length} total entities found in ${totalTime}s`);

        res.json({
            meta: {
                query,
                candidates_scanned: totalCandidates,
                ig_candidates: uniqueIgItems.length,
                web_candidates: uniqueWebItems.length,
                queries_used: expansion.queries.length,
                location: expansion.location,
                intent: expansion.intent,
                expanded_queries: expansion.queries,
                time_seconds: parseFloat(totalTime)
            },
            results: finalResults,
            debug: errors.length > 0 ? { errors } : undefined
        });

    } catch (error) {
        console.error("   ❌ Critical Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n🚀 OMNI-SEARCH ENGINE v3.0 ACTIVE ON PORT ${PORT}`);
    console.log(`   Powered by Gemini 2.0 Flash | Max Coverage Mode`);
});
