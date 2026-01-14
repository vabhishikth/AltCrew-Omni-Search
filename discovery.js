require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ApifyClient } = require('apify-client');

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Initialize Apify client
const apifyClient = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

// ═══════════════════════════════════════════════════════════════════════════
// AGGRESSIVE DRAGNET - Capture EVERYTHING in Visakhapatnam
// ═══════════════════════════════════════════════════════════════════════════

// KNOWN CLUB HANDLES - These are scraped DIRECTLY regardless of hashtags
// Add any club usernames you discover that might be missed by hashtag scraping
const KNOWN_HANDLES = [
    'solemates__runclub',      // Soul Mates Run Club
    'on.the.move.runclub',     // On The Move Vizag Run Club
    'vizagruncollective',      // Vizag Run Collective
    'culture.runclub_',        // Culture Run Club
];


// MASSIVE hashtag list covering ALL fitness/sports/wellness communities
const CITY_HASHTAGS = [
    // Running Communities (HIGH PRIORITY based on screenshots)
    'vizagrunners',
    'vizagruncollective',
    'onthemove',
    'runclub',
    'vizagrunclub',
    'runandrave',
    'communityrun',
    'solemates',
    'culturerunclub',
    '5krun',
    '3krun',
    'morningrun',
    'runwithus',
    'runcommunity',
    'runningcommunity',

    // Cycling Communities
    'vizagcyclists',
    'vizagcycling',
    'cyclingvizag',
    'vizagbikers',
    'vizagriders',

    // Fitness & Gyms
    'vizagfitness',
    'fitnessvizag',
    'vizaggym',
    'gymvizag',
    'fitnessvisakhapatnam',
    'vizagworkout',
    'crossfitvizag',

    // Sports
    'vizagmarathon',
    'vizagbadminton',
    'vizagtennis',
    'vizagsports',
    'sportsvizag',

    // Yoga & Wellness
    'vizagyoga',
    'yogavizag',
    'vizagwellness',

    // Events & Lifestyle
    'vizagevents',
    'activevizag',
    'vizaglifestyle',
    'vizagactive',
    'vizagmorning',

    // General Vizag hashtags that capture fitness content
    'visakhapatnam',
    'vizag',
    'waltair',
];

// Posts to scrape per hashtag (100 × ~45 hashtags = 4500 posts scanned)
const POSTS_PER_HASHTAG = 100;

// Keywords for signal score calculation (not for filtering!)
const SCORE_KEYWORDS = [
    'club', 'group', 'community', 'gym', 'fitness', 'studio', 'training', 'arena',
    'workout', 'health', 'sports', 'exercise', 'fit', 'wellness', 'crossfit',
    'yoga', 'zumba', 'pilates', 'martial', 'boxing', 'running', 'cycling',
    'academy', 'association', 'team', 'squad', 'warriors', 'riders', 'walkers',
    'collective', 'crew', 'movement', 'run', 'marathon', 'triathlon',
    '💪', '🏋️', '🏃', '🧘', '🥊', '🚴', '🏸', '🎾'
];

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function calculateSignalScore(name, bio, followers) {
    let score = 0;
    const text = ((name || '') + ' ' + (bio || '')).toLowerCase();

    SCORE_KEYWORDS.forEach(keyword => {
        if (text.includes(keyword.toLowerCase())) score += 5;
    });

    if (followers >= 10000) score += 30;
    else if (followers >= 5000) score += 20;
    else if (followers >= 1000) score += 10;
    else if (followers >= 500) score += 5;

    return Math.min(score, 100);
}

function countKeywords(name, bio) {
    const text = ((name || '') + ' ' + (bio || '')).toLowerCase();
    return SCORE_KEYWORDS.filter(k => text.includes(k.toLowerCase())).length;
}

function truncateForDB(text, maxLength = 95) {
    if (text === null || text === undefined) return '';
    const str = String(text);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
}

function displayBio(bio, maxLength = 70) {
    if (!bio) return '(no bio)';
    const cleaned = bio.replace(/\n/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.substring(0, maxLength) + '...';
}

function extractCity(profile) {
    if (profile.businessAddress) return profile.businessAddress;
    if (profile.locationName) return profile.locationName;
    if (profile.city) return profile.city;
    return 'Visakhapatnam';
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: COLLECT ALL USERNAMES FROM ALL HASHTAGS
// ═══════════════════════════════════════════════════════════════════════════

async function collectUsernamesFromHashtags() {
    console.log('\n' + '═'.repeat(70));
    console.log('📡 STEP 1: COLLECTING USERNAMES');
    console.log('═'.repeat(70));

    // First, add all known handles directly
    const usernames = new Set(KNOWN_HANDLES);
    console.log(`   🎯 Known handles pre-loaded: ${KNOWN_HANDLES.length}`);
    KNOWN_HANDLES.forEach(h => console.log(`      → @${h}`));

    console.log(`\n   🏷️  Hashtags to scan: ${CITY_HASHTAGS.length}`);
    console.log(`   📬 Posts per hashtag: ${POSTS_PER_HASHTAG}`);
    console.log(`   📊 Total posts to analyze: ~${CITY_HASHTAGS.length * POSTS_PER_HASHTAG}\n`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < CITY_HASHTAGS.length; i++) {
        const hashtag = CITY_HASHTAGS[i];
        const progress = `[${i + 1}/${CITY_HASHTAGS.length}]`;

        process.stdout.write(`🔍 ${progress} Scanning #${hashtag}...`);

        try {
            const run = await apifyClient.actor('apify/instagram-hashtag-scraper').call({
                hashtags: [hashtag],
                resultsLimit: POSTS_PER_HASHTAG,
            });

            const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();

            let newCount = 0;
            for (const post of items) {
                const username = post.ownerUsername || (post.ownerProfile && post.ownerProfile.username);
                if (username && !usernames.has(username)) {
                    usernames.add(username);
                    newCount++;
                }
            }
            console.log(` ✅ ${items.length} posts → +${newCount} new (Total: ${usernames.size})`);
            successCount++;
        } catch (error) {
            console.log(` ❌ Error: ${error.message.substring(0, 50)}`);
            failCount++;
        }
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📊 SCAN COMPLETE:`);
    console.log(`   ✅ Successful hashtags: ${successCount}`);
    console.log(`   ❌ Failed hashtags: ${failCount}`);
    console.log(`   👤 Unique usernames: ${usernames.size}`);
    console.log('─'.repeat(70));

    return Array.from(usernames);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: FETCH FULL PROFILE DETAILS (in batches)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchProfileDetails(usernames) {
    console.log('\n' + '═'.repeat(70));
    console.log('👤 STEP 2: FETCHING FULL PROFILE DETAILS');
    console.log('═'.repeat(70));
    console.log(`   Profiles to fetch: ${usernames.length}\n`);

    if (usernames.length === 0) {
        console.log('   ⚠️  No usernames to fetch');
        return [];
    }

    const allProfiles = [];
    const BATCH_SIZE = 50; // Process in batches to avoid timeouts
    const batches = [];

    for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
        batches.push(usernames.slice(i, i + BATCH_SIZE));
    }

    console.log(`   📦 Processing in ${batches.length} batches of ${BATCH_SIZE}\n`);

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        process.stdout.write(`   ⏳ Batch ${i + 1}/${batches.length} (${batch.length} profiles)...`);

        try {
            const run = await apifyClient.actor('apify/instagram-profile-scraper').call({
                usernames: batch,
            });

            const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
            allProfiles.push(...items);
            console.log(` ✅ Got ${items.length} profiles`);
        } catch (error) {
            console.log(` ❌ Error: ${error.message.substring(0, 40)}`);
        }
    }

    console.log(`\n   📊 Total profiles fetched: ${allProfiles.length}`);
    return allProfiles;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: SAVE ALL PROFILES TO SUPABASE (NO FILTERING!)
// ═══════════════════════════════════════════════════════════════════════════

async function saveAllProfiles(profiles) {
    console.log('\n' + '═'.repeat(70));
    console.log('💾 STEP 3: SAVING ALL PROFILES TO SUPABASE');
    console.log('═'.repeat(70));
    console.log(`   ⚠️  Mode: AGGRESSIVE - Saving ALL ${profiles.length} profiles (NO FILTERING)\n`);

    let saved = 0;
    let errors = 0;

    for (const profile of profiles) {
        const username = profile.username;
        const bio = profile.biography || profile.bio || '';
        const name = profile.fullName || profile.full_name || username;
        const followers = profile.followersCount || profile.followers || 0;

        const signalScore = calculateSignalScore(name, bio, followers);
        const keywordCount = countKeywords(name, bio);
        const city = extractCity(profile);

        const clubData = {
            name: truncateForDB(name, 95),
            instagram_handle: username,
            bio: truncateForDB(bio, 500),
            followers: followers,
            city: truncateForDB(city, 95),
            signal_score: signalScore,
        };

        const { error } = await supabase
            .from('clubs')
            .upsert(clubData, {
                onConflict: 'instagram_handle',
                ignoreDuplicates: false
            });

        if (error) {
            console.log(`   ❌ @${username}: ${error.message}`);
            errors++;
        } else {
            console.log(`   ✅ @${username} | Score: ${signalScore} | ${followers.toLocaleString()} followers | ${keywordCount} keywords`);
            console.log(`      📝 ${displayBio(bio)}`);
            saved++;
        }
    }

    return { saved, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN AGGRESSIVE DRAGNET
// ═══════════════════════════════════════════════════════════════════════════

async function runAggressiveDragnet() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  🚀 AGGRESSIVE VISAKHAPATNAM DRAGNET - CAPTURE EVERYTHING!           ║');
    console.log('╠══════════════════════════════════════════════════════════════════════╣');
    console.log('║  No filtering - Every profile goes into the database                 ║');
    console.log('║  You can filter/curate manually in Supabase later                    ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    const startTime = Date.now();

    try {
        // Step 1: Collect usernames from ALL hashtags
        const usernames = await collectUsernamesFromHashtags();

        if (usernames.length === 0) {
            console.log('\n❌ No usernames found. Exiting.');
            return;
        }

        // Step 2: Fetch full profile details
        const profiles = await fetchProfileDetails(usernames);

        if (profiles.length === 0) {
            console.log('\n❌ Could not fetch any profiles. Exiting.');
            return;
        }

        // Step 3: Save ALL profiles to Supabase
        const { saved, errors } = await saveAllProfiles(profiles);

        // Final Report
        const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════════════╗');
        console.log('║                   🎯 AGGRESSIVE DRAGNET COMPLETE!                    ║');
        console.log('╠══════════════════════════════════════════════════════════════════════╣');
        console.log(`║  🏷️  Hashtags scanned:      ${CITY_HASHTAGS.length.toString().padEnd(41)}║`);
        console.log(`║  📬  Posts analyzed:        ~${(CITY_HASHTAGS.length * POSTS_PER_HASHTAG).toString().padEnd(40)}║`);
        console.log(`║  👤  Unique usernames:      ${usernames.length.toString().padEnd(41)}║`);
        console.log(`║  📥  Profiles fetched:      ${profiles.length.toString().padEnd(41)}║`);
        console.log(`║  ✅  Saved to database:     ${saved.toString().padEnd(41)}║`);
        console.log(`║  ❌  Errors:                ${errors.toString().padEnd(41)}║`);
        console.log(`║  ⏱️   Duration:             ${(duration + ' minutes').padEnd(41)}║`);
        console.log('╚══════════════════════════════════════════════════════════════════════╝');
        console.log('\n💡 Tip: Use Supabase to filter by signal_score > 20 for quality leads!\n');

    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        process.exit(1);
    }
}

// Run the aggressive dragnet
runAggressiveDragnet();
