const { SlashCommandBuilder } = require('@discordjs/builders');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');

const LOGIN_URL = 'https://kingshot-giftcode.centurygame.com/api/player';
const REDEEM_URL = 'https://kingshot-giftcode.centurygame.com/api/gift_code';
const WOS_ENCRYPT_KEY = 'mN4!pQs6JrYwV9';

const DELAY_MS = 1_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 3;

const LOG_FILE = path.join(__dirname, '..', 'redeemed_codes.txt');

const RESULT_MESSAGES = {
    SUCCESS: 'Successfully redeemed',
    RECEIVED: 'Already redeemed',
    'SAME TYPE EXCHANGE': 'Successfully redeemed (same type)',
    'TIME ERROR': 'Code has expired',
    'TIMEOUT RETRY': 'Server requested retry',
    USED: 'Claim limit reached, unable to claim',
};

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logMessage(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const entry = `${timestamp} - ${message}`;

    try {
        console.log(entry);
    } catch (error) {
        const cleaned = entry
            .replace(/[^\x00-\x7F]+/g, '?');
        console.log(cleaned);
    }

    try {
        await fs.appendFile(LOG_FILE, `${entry}\n`, { encoding: 'utf8' });
    } catch (error) {
        console.error(
            `${timestamp} - LOGGING ERROR: Could not write to ${LOG_FILE}. Error: ${error.message}`
        );
        console.error(`${timestamp} - ORIGINAL MESSAGE: ${entry}`);
    }

    return entry;
}

function encodeData(data) {
    const secret = WOS_ENCRYPT_KEY;
    const sortedKeys = Object.keys(data).sort();
    const encodedData = sortedKeys
        .map((key) => {
            const value = data[key];
            return `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`;
        })
        .join('&');

    const sign = crypto.createHash('md5').update(`${encodedData}${secret}`).digest('hex');
    return { sign, ...data };
}

function postJson(urlString, payload) {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);

    const options = {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        port: url.port || 443,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };

    return new Promise((resolve, reject) => {
        const request = https.request(options, (response) => {
            let raw = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                raw += chunk;
            });

            response.on('end', () => {
                resolve({ statusCode: response.statusCode, body: raw });
            });
        });

        request.on('error', (error) => {
            reject(error);
        });

        request.write(body);
        request.end();
    });
}

async function makeRequest(url, payload) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        try {
            const response = await postJson(url, payload);
            const body = response.body || '';
            let data;

            try {
                data = body ? JSON.parse(body) : undefined;
            } catch (error) {
                await logMessage(
                    `Attempt ${attempt + 1} failed for FID ${payload.fid || 'N/A'}: JSON parse error: ${error.message}. Response text: ${body.slice(0, 200)}`
                );
                data = undefined;
            }

            if (response.statusCode === 200) {
                const msgContent =
                    data && typeof data.msg === 'string'
                        ? data.msg.replace(/\.+$/, '')
                        : undefined;

                if (msgContent === 'TIMEOUT RETRY' && attempt < MAX_RETRIES - 1) {
                    await logMessage(
                        `Attempt ${attempt + 1}: Server requested retry for payload: ${payload.fid || 'N/A'}`
                    );
                    await delay(RETRY_DELAY_MS);
                    continue;
                }

                return data;
            }

            await logMessage(
                `Attempt ${attempt + 1} failed for FID ${payload.fid || 'N/A'}: HTTP ${response.statusCode}, Response: ${body.slice(0, 200)}`
            );
        } catch (error) {
            await logMessage(
                `Attempt ${attempt + 1} failed for FID ${payload.fid || 'N/A'}: ${error.name}: ${error.message}`
            );
        }

        if (attempt < MAX_RETRIES - 1) {
            await delay(RETRY_DELAY_MS);
        }
    }

    await logMessage(
        `All ${MAX_RETRIES} attempts failed for request to ${url} with FID ${payload.fid || 'N/A'}.`
    );
    return undefined;
}

async function redeemGiftCode(fid, code) {
    if (!String(fid).trim().match(/^\d+$/)) {
        await logMessage(`Skipping invalid FID: '${fid}'`);
        return { msg: 'Invalid FID format' };
    }

    const trimmedFid = String(fid).trim();

    try {
        const loginPayload = encodeData({ fid: trimmedFid, time: Date.now() });
        const loginData = await makeRequest(LOGIN_URL, loginPayload);

        if (!loginData) {
            return { msg: 'Login request failed after retries' };
        }

        if (loginData.code !== 0) {
            const loginMsg = loginData.msg || 'Unknown login error';
            await logMessage(
                `Login failed for ${trimmedFid}: Code ${loginData.code}, Message: ${loginMsg}`
            );
            return { msg: `Login failed: ${loginMsg}` };
        }

        const nickname = loginData.data && loginData.data.nickname;
        await logMessage(`Processing ${nickname || 'Unknown Player'} (${trimmedFid})`);

        const redeemPayload = encodeData({ fid: trimmedFid, cdk: code, time: Date.now() });
        const redeemData = await makeRequest(REDEEM_URL, redeemPayload);

        if (!redeemData) {
            return { msg: 'Redemption request failed after retries' };
        }

        return redeemData;
    } catch (error) {
        await logMessage(`Unexpected error during redemption for ${trimmedFid}: ${error.message}`);
        return { msg: `Unexpected Error: ${error.message}` };
    }
}

function parsePlayerIds(content) {
    return content
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

function createSummaryMessage({
    filePath,
    code,
    processed,
    counters,
    details,
    exitReason,
}) {
    const relativeLog = path.relative(process.cwd(), LOG_FILE);
    const summaryLines = [
        `Gift code: ${code}`,
        `Source file: ${filePath}`,
        `Player IDs processed: ${processed}`,
        `Successfully redeemed: ${counters.success}`,
        `Already redeemed: ${counters.alreadyRedeemed}`,
        `Errors/Failures: ${counters.errors}`,
    ];

    if (exitReason) {
        summaryLines.push(`Stopped early: ${exitReason}`);
    }

    summaryLines.push(`Full log saved to: ${relativeLog}`);

    const detailLines = details.length > 0 ? ['\nRecent results:', ...details] : [];

    let message = summaryLines.concat(detailLines).join('\n');

    if (message.length > 1900) {
        message = summaryLines.join('\n');
    }

    return message;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('redeem')
        .setDescription('Redeem a Kingshot gift code for players listed in a text file.')
        .addStringOption((option) =>
            option
                .setName('code')
                .setDescription('The gift code to redeem.')
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName('file')
                .setDescription('Path to a text file that lists player IDs (comma or newline separated).')
                .setRequired(true)
        ),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const code = interaction.options.getString('code', true).trim();
        const filePath = interaction.options.getString('file', true).trim();

        let fileContent;

        try {
            fileContent = await fs.readFile(filePath, { encoding: 'utf8' });
        } catch (error) {
            await interaction.editReply(
                `Failed to read file at \`${filePath}\`: ${error.message}`
            );
            return;
        }

        const playerIds = parsePlayerIds(fileContent);

        if (playerIds.length === 0) {
            await interaction.editReply(
                `No player IDs were found in \`${filePath}\`. Ensure the file contains IDs separated by commas or new lines.`
            );
            return;
        }

        await logMessage(
            `\n=== Starting redemption for gift code: ${code} at ${new Date()
                .toISOString()
                .replace('T', ' ')
                .split('.')[0]} ===`
        );

        const counters = {
            success: 0,
            alreadyRedeemed: 0,
            errors: 0,
        };

        const recentDetails = [];
        let exitReason;
        let processedCount = 0;

        for (const fid of playerIds) {
            processedCount += 1;
            const result = await redeemGiftCode(fid, code);
            const rawMsg =
                result && typeof result.msg === 'string'
                    ? result.msg.replace(/\.+$/, '')
                    : 'Unknown error';
            const friendlyMsg = RESULT_MESSAGES[rawMsg] || rawMsg;

            if (rawMsg === 'SUCCESS' || rawMsg === 'SAME TYPE EXCHANGE') {
                counters.success += 1;
            } else if (rawMsg === 'RECEIVED') {
                counters.alreadyRedeemed += 1;
            } else if (rawMsg === 'TIMEOUT RETRY') {
                // ignored, no counter update
            } else {
                counters.errors += 1;
            }

            recentDetails.push(`${fid}: ${friendlyMsg}`);
            if (recentDetails.length > 10) {
                recentDetails.shift();
            }

            await logMessage(`Result: ${friendlyMsg}`);

            if (rawMsg === 'TIME ERROR') {
                exitReason = 'Code has expired';
                break;
            }

            if (rawMsg === 'USED') {
                exitReason = 'Claim limit reached';
                break;
            }

            await delay(DELAY_MS);
        }

        await logMessage('\n=== Redemption Complete ===');
        await logMessage(`Successfully redeemed: ${counters.success}`);
        await logMessage(`Already redeemed: ${counters.alreadyRedeemed}`);
        await logMessage(`Errors/Failures: ${counters.errors}`);

        const message = createSummaryMessage({
            filePath,
            code,
            processed: processedCount,
            counters,
            details: recentDetails,
            exitReason,
        });

        await interaction.editReply(message);
    },
};
