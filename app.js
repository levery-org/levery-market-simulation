require("dotenv").config();
const axios = require("axios");
const { subDays, format } = require("date-fns");
const { ethers } = require("ethers");
const fs = require("fs");
const AggregatorV3InterfaceABI = require("./AggregatorV3Interface.json");

const UNISWAP_V3_SUBGRAPH_URL = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
const CHAINLINK_ORACLE_ADDRESS = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const DAYS_NUMBER_TO_COMPARE = 90;
const RPC_URL = process.env.RPC_URL || "https://rpc.flashbots.net";
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;
const LP_FEE_MULTIPLIER = 70;
const ROUNDS_FILE = "rounds.json";

const poolQuery = `
  query MyQuery($timestamp: Int!, $lastId: String) {
    pool(id: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8") {
      token0Price
      token1Price
      feeTier
      swaps(where: { timestamp_gte: $timestamp, id_gt: $lastId }, orderDirection: desc, orderBy: timestamp, first: 1000) {
        id
        amount0
        amount1
        timestamp
        transaction {
          id
        }
      }
    }
  }
`;

function createLogger(outputFileName) {
  const logDirectory = "logs";
  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
  }

  const logStream = fs.createWriteStream(outputFileName, { flags: "a" });

  return function log(message) {
    console.log(message);
    logStream.write(`${message}\n`);
  };
}

async function fetchWithRetry(fetchFunction, ...args) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchFunction(...args);
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(`Error occurred. Retrying attempt ${attempt}/${MAX_RETRIES}...`);
        await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
      } else {
        throw error;
      }
    }
  }
}

async function fetchSwaps(startTime) {
  let allSwaps = [];
  let lastId = "";
  let hasMore = true;

  while (hasMore) {
    const response = await axios.post(UNISWAP_V3_SUBGRAPH_URL, {
      query: poolQuery,
      variables: {
        timestamp: Math.floor(startTime / 1000),
        lastId: lastId,
      },
    });

    const pool = response.data.data.pool;
    if (!pool) {
      throw new Error("Pool not found");
    }

    const swaps = pool.swaps;
    allSwaps = allSwaps.concat(swaps);
    if (swaps.length < 1000) {
      hasMore = false;
    } else {
      lastId = swaps[swaps.length - 1].id;
    }
  }

  return allSwaps;
}

async function fetchRoundDataWithRetry(priceFeed, roundId, log) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await Promise.race([
        priceFeed.getRoundData(roundId),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), FETCH_TIMEOUT_MS)),
      ]);
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        log(`Fetch round data failed (attempt ${attempt}/${MAX_RETRIES}). Retrying...`);
        await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
      } else {
        throw error;
      }
    }
  }
}

async function fetchHistoricalChainlinkPrices(provider, priceFeed, startTime, endTime, log) {
  let prices = [];

  if (fs.existsSync(ROUNDS_FILE)) {
    prices = JSON.parse(fs.readFileSync(ROUNDS_FILE));
    log(`Loaded Chainlink prices from ${ROUNDS_FILE}`);
  } else {
    prices = [];
  }

  let roundId = await priceFeed.latestRound();
  let roundData = await fetchRoundDataWithRetry(priceFeed, roundId, log);

  log(`Fetching Chainlink prices from ${startTime} to ${endTime}`);

  // Iterate backwards to collect prices within the time range
  while (roundData.updatedAt > startTime && roundId.gt(0)) {
    if (roundData.updatedAt <= endTime && !prices.find((p) => p.roundId === roundId.toString())) {
      prices.push({
        roundId: roundId.toString(),
        timestamp: roundData.updatedAt.toString(),
        price: parseFloat(ethers.utils.formatUnits(roundData.answer, await priceFeed.decimals())),
      });
      log(`Round ${roundId}: ${roundData.updatedAt} - Price: ${prices[prices.length - 1].price}`);
    }
    roundId = roundId.sub(1);
    roundData = await fetchRoundDataWithRetry(priceFeed, roundId, log);
  }

  // Add extra older rounds to ensure there is always a Chainlink price available
  for (let i = 0; i < 5; i++) {
    roundId = roundId.sub(1);
    roundData = await fetchRoundDataWithRetry(priceFeed, roundId, log);
    prices.push({
      roundId: roundId.toString(),
      timestamp: roundData.updatedAt.toString(),
      price: parseFloat(ethers.utils.formatUnits(roundData.answer, await priceFeed.decimals())),
    });
    log(`Extra Round ${roundId}: ${roundData.updatedAt} - Price: ${prices[prices.length - 1].price}`);
  }

  log(`Total rounds fetched: ${prices.length}`);
  fs.writeFileSync(ROUNDS_FILE, JSON.stringify(prices, null, 2));
  log(`Chainlink prices saved to ${ROUNDS_FILE}`);

  return prices;
}

async function main() {
  const currentDate = format(new Date(), "yyyy-MM-dd-HH-mm-ss");
  const outputFileName = `output/${currentDate}.json`;
  const logFileName = `logs/${currentDate}.txt`;
  const log = createLogger(logFileName);

  const outputDirectory = "output";
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory);
  }

  log("Simulation started at " + new Date());
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const priceFeed = new ethers.Contract(CHAINLINK_ORACLE_ADDRESS, AggregatorV3InterfaceABI, provider);
  const daysAgo = subDays(new Date(), DAYS_NUMBER_TO_COMPARE).getTime();
  const now = Date.now();

  let resultData = {
    totalSwaps: 0,
    totalVolumeETH: 0,
    totalVolumeUSDC: 0,
    totalStandardFee: 0,
    totalDynamicLeveryFee: 0,
    averageLeveryEfficiencyPercent: 0,
    swaps: [],
  };

  try {
    // Fetch historical Chainlink prices
    const chainlinkPrices = await fetchHistoricalChainlinkPrices(provider, priceFeed, daysAgo / 1000, now / 1000, log);

    // Fetch swaps from Uniswap
    const swaps = await fetchSwaps(daysAgo);

    let totalStandardFee = 0;
    let totalDynamicLeveryFee = 0;
    let totalLeveryEfficiencyPercent = 0;

    for (const swap of swaps) {
      const swapTimestamp = new Date(swap.timestamp * 1000).toISOString();
      log(`Timestamp: ${swapTimestamp}`);
      log(`Transaction Hash: ${swap.transaction.id}`);

      const amount0 = parseFloat(swap.amount0);
      const amount1 = parseFloat(swap.amount1);
      let price;
      let isBuyingETH = false;
      let isSellingETH = false;

      if (amount0 < 0) {
        log(`User paid ${-amount0} USDC and received ${amount1} ETH`);
        price = -amount0 / amount1;
        resultData.totalVolumeETH += amount1;
        resultData.totalVolumeUSDC += -amount0;
        isBuyingETH = true;
      } else {
        log(`User paid ${-amount1} ETH and received ${amount0} USDC`);
        price = amount0 / -amount1;
        resultData.totalVolumeETH += -amount1;
        resultData.totalVolumeUSDC += amount0;
        isSellingETH = true;
      }

      // Find the closest Chainlink price for the swap timestamp that is equal to or less than the swap timestamp
      const chainlinkPriceData = chainlinkPrices
        .filter((p) => parseInt(p.timestamp) <= swap.timestamp)
        .sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp))[0];

      const chainlinkPrice = chainlinkPriceData ? chainlinkPriceData.price : "N/A";
      const chainlinkTimestamp = chainlinkPriceData
        ? new Date(parseInt(chainlinkPriceData.timestamp) * 1000).toISOString()
        : "N/A";
      const timeDifference = chainlinkPriceData
        ? Math.abs(swap.timestamp - parseInt(chainlinkPriceData.timestamp))
        : "N/A";

      log(`Price of 1 ETH in USDC: ${price}`);
      log(`Chainlink Oracle Price of 1 ETH in USDC at swap time: ${chainlinkPrice} (Timestamp: ${chainlinkTimestamp})`);
      log(`Time difference between swap and oracle: ${timeDifference / 60} minutes`);

      let dynamicLeveryFeePercent = 0.05;
      let priceDifferencePercent = 0;
      if (chainlinkPrice !== "N/A") {
        priceDifferencePercent = ((price - chainlinkPrice) / chainlinkPrice) * 100;
        log(`Price difference: ${price - chainlinkPrice} (${priceDifferencePercent.toFixed(2)}%)`);

        priceDifferencePercent = Math.abs(priceDifferencePercent);
        dynamicLeveryFeePercent += (priceDifferencePercent * LP_FEE_MULTIPLIER) / 100;
      }

      const leveryHookPricePlusFee = price + (price * dynamicLeveryFeePercent) / 100;
      const leveryHookPriceMinusFee = price - (price * dynamicLeveryFeePercent) / 100;

      log(`Dynamic Levery Fee: ${dynamicLeveryFeePercent.toFixed(2)}%`);
      if (isBuyingETH) {
        log(`Levery Hook Price + Fee: ${leveryHookPricePlusFee.toFixed(6)} USD`);
      } else if (isSellingETH) {
        log(`Levery Hook Price - Fee: ${leveryHookPriceMinusFee.toFixed(6)} USD`);
      }

      const standardFeePercent = 0.05;
      const swapAmount = Math.abs(amount0) > Math.abs(amount1) ? Math.abs(amount0) : Math.abs(amount1);
      const standardFee = (swapAmount * standardFeePercent) / 100;
      const dynamicLeveryFee = (swapAmount * dynamicLeveryFeePercent) / 100;

      totalStandardFee += standardFee;
      totalDynamicLeveryFee += dynamicLeveryFee;

      log(`If Using Uniswap V3 - LPs Fee: ${standardFee.toFixed(6)} USD (0.05%)`);
      log(
        `If Using Levery Hook - LPs Fee: ${dynamicLeveryFee.toFixed(6)} USD (${dynamicLeveryFeePercent.toFixed(2)}%)`
      );

      // Calculate the Efficiency percentage of Levery Hook Price
      let leveryEfficiencyPercent = 0;
      if (isBuyingETH) {
        leveryEfficiencyPercent = ((chainlinkPrice - leveryHookPricePlusFee) / chainlinkPrice) * 100;
        log(`Levery is cheaper by: ${leveryEfficiencyPercent.toFixed(2)}% for buying ETH`);
      } else if (isSellingETH) {
        leveryEfficiencyPercent = ((leveryHookPriceMinusFee - chainlinkPrice) / chainlinkPrice) * 100;
        log(`Levery pays more by: ${leveryEfficiencyPercent.toFixed(2)}% for selling ETH`);
      }

      totalLeveryEfficiencyPercent += leveryEfficiencyPercent;

      log("---");

      let swapData = {
        swapTimestamp,
        transactionHash: swap.transaction.id,
        amount0,
        amount1,
        price,
        isBuyingETH,
        isSellingETH,
        chainlinkPrice,
        chainlinkTimestamp,
        timeDifference,
        priceDifferencePercent: ((price - chainlinkPrice) / chainlinkPrice) * 100,
        dynamicLeveryFeePercent,
        standardFee,
        dynamicLeveryFee,
        leveryEfficiencyPercent,
      };

      if (isBuyingETH) {
        swapData.leveryHookPricePlusFee = leveryHookPricePlusFee;
      } else if (isSellingETH) {
        swapData.leveryHookPriceMinusFee = leveryHookPriceMinusFee;
      }

      resultData.swaps.push(swapData);

      resultData.totalSwaps += 1;
    }

    resultData.totalStandardFee = totalStandardFee;
    resultData.totalDynamicLeveryFee = totalDynamicLeveryFee;
    resultData.averageLeveryEfficiencyPercent = totalLeveryEfficiencyPercent / resultData.totalSwaps;

    fs.writeFileSync(outputFileName, JSON.stringify(resultData, null, 2));
    log(`Data written to ${outputFileName}`);

    // Log the totals at the end
    log(`Total swaps: ${resultData.totalSwaps}`);
    log(`Total volume transacted: ${resultData.totalVolumeETH} ETH and ${resultData.totalVolumeUSDC} USDC`);
    log(`Total Standard LPs Fee: ${totalStandardFee.toFixed(6)} USD`);
    log(`Total Dynamic Levery LPs Fee: ${totalDynamicLeveryFee.toFixed(6)} USD`);
    log(`Average Levery Price Efficiency for Swappers: ${resultData.averageLeveryEfficiencyPercent.toFixed(2)}%`);
  } catch (error) {
    log(`Error occurred: ${error.message}`);
  }
}

main().catch(console.error);
