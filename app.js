require("dotenv").config();
const axios = require("axios");
const { subDays, format } = require("date-fns");
const { ethers } = require("ethers");
const fs = require("fs");
const AggregatorV3InterfaceABI = require("./AggregatorV3Interface.json");

const UNISWAP_V3_SUBGRAPH_URL = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
const CHAINLINK_ORACLE_ADDRESS = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const DAYS_NUMBER_TO_COMPARE = 1;

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

async function fetchHistoricalChainlinkPrices(provider, priceFeed, startTime, endTime) {
  let roundId = await priceFeed.latestRound();
  let roundData = await priceFeed.getRoundData(roundId);
  const prices = [];
  console.log(`Fetching Chainlink prices from ${startTime} to ${endTime}`);

  // Iterate backwards to collect prices within the time range
  while (roundData.updatedAt > startTime && roundId.gt(0)) {
    if (roundData.updatedAt <= endTime) {
      prices.push({
        timestamp: roundData.updatedAt,
        price: parseFloat(ethers.utils.formatUnits(roundData.answer, await priceFeed.decimals())),
      });
      console.log(`Round ${roundId}: ${roundData.updatedAt} - Price: ${prices[prices.length - 1].price}`);
    }
    roundId = roundId.sub(1);
    roundData = await priceFeed.getRoundData(roundId);
  }

  // Add extra older rounds to ensure there is always a Chainlink price available
  for (let i = 0; i < 5; i++) {
    roundId = roundId.sub(1);
    roundData = await priceFeed.getRoundData(roundId);
    prices.push({
      timestamp: roundData.updatedAt,
      price: parseFloat(ethers.utils.formatUnits(roundData.answer, await priceFeed.decimals())),
    });
    console.log(`Extra Round ${roundId}: ${roundData.updatedAt} - Price: ${prices[prices.length - 1].price}`);
  }

  console.log(`Total rounds fetched: ${prices.length}`);
  return prices;
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(
    `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`
  );
  const priceFeed = new ethers.Contract(CHAINLINK_ORACLE_ADDRESS, AggregatorV3InterfaceABI, provider);
  const daysAgo = subDays(new Date(), DAYS_NUMBER_TO_COMPARE).getTime();
  const now = Date.now();
  const currentDate = format(new Date(), "yyyy-MM-dd");
  const outputFileName = `${currentDate}.json`;

  let resultData = {
    totalSwaps: 0,
    totalVolumeETH: 0,
    totalVolumeUSDC: 0,
    totalStandardFee: 0,
    totalDynamicLeveryFee: 0,
    swaps: [],
  };

  try {
    // Fetch historical Chainlink prices
    const chainlinkPrices = await fetchHistoricalChainlinkPrices(provider, priceFeed, daysAgo / 1000, now / 1000);

    // Fetch swaps from Uniswap
    const swaps = await fetchSwaps(daysAgo);

    let totalStandardFee = 0;
    let totalDynamicLeveryFee = 0;

    for (const swap of swaps) {
      const swapTimestamp = new Date(swap.timestamp * 1000).toISOString();
      console.log(`Timestamp: ${swapTimestamp}`);
      console.log(`Transaction Hash: ${swap.transaction.id}`);

      const amount0 = parseFloat(swap.amount0);
      const amount1 = parseFloat(swap.amount1);
      let price;
      let isBuyingETH = false;
      let isSellingETH = false;

      if (amount0 < 0) {
        console.log(`User paid ${-amount0} USDC and received ${amount1} ETH`);
        price = -amount0 / amount1;
        resultData.totalVolumeETH += amount1;
        resultData.totalVolumeUSDC += -amount0;
        isBuyingETH = true;
      } else {
        console.log(`User paid ${-amount1} ETH and received ${amount0} USDC`);
        price = amount0 / -amount1;
        resultData.totalVolumeETH += -amount1;
        resultData.totalVolumeUSDC += amount0;
        isSellingETH = true;
      }

      // Find the closest Chainlink price for the swap timestamp that is equal to or less than the swap timestamp
      const chainlinkPriceData = chainlinkPrices
        .filter((p) => p.timestamp <= swap.timestamp)
        .sort((a, b) => b.timestamp - a.timestamp)[0];

      const chainlinkPrice = chainlinkPriceData ? chainlinkPriceData.price : "N/A";
      const chainlinkTimestamp = chainlinkPriceData
        ? new Date(chainlinkPriceData.timestamp * 1000).toISOString()
        : "N/A";
      const timeDifference = chainlinkPriceData ? Math.abs(swap.timestamp - chainlinkPriceData.timestamp) : "N/A";

      console.log(`Price of 1 ETH in USDC: ${price}`);
      console.log(
        `Chainlink Oracle Price of 1 ETH in USDC at swap time: ${chainlinkPrice} (Timestamp: ${chainlinkTimestamp})`
      );
      console.log(`Time difference between swap and oracle: ${timeDifference / 60} minutes`);

      let dynamicLeveryFeePercent = 0.05;
      let priceDifferencePercent = 0;
      if (chainlinkPrice !== "N/A") {
        priceDifferencePercent = ((price - chainlinkPrice) / chainlinkPrice) * 100;
        console.log(`Price difference: ${price - chainlinkPrice} (${priceDifferencePercent.toFixed(2)}%)`);

        priceDifferencePercent = Math.abs(priceDifferencePercent);

        if (chainlinkPrice > price && isBuyingETH) {
          dynamicLeveryFeePercent += 0.9 * priceDifferencePercent;
        } else if (chainlinkPrice < price && isSellingETH) {
          dynamicLeveryFeePercent += 0.9 * priceDifferencePercent;
        }
      }

      const leveryHookPricePlusFee = price + 0.9 * priceDifferencePercent;

      console.log(`Dynamic Levery Fee: ${dynamicLeveryFeePercent.toFixed(2)}%`);
      console.log(`Levery Hook Price + Fee: ${leveryHookPricePlusFee.toFixed(6)} USD`);

      const standardFeePercent = 0.05;
      const swapAmount = Math.abs(amount0) > Math.abs(amount1) ? Math.abs(amount0) : Math.abs(amount1);
      const standardFee = (swapAmount * standardFeePercent) / 100;
      const dynamicLeveryFee = (swapAmount * dynamicLeveryFeePercent) / 100;

      totalStandardFee += standardFee;
      totalDynamicLeveryFee += dynamicLeveryFee;

      console.log(`Standard Fee: ${standardFee.toFixed(6)} USD (0.05%)`);
      console.log(
        `Dynamic Levery Fee Amount: ${dynamicLeveryFee.toFixed(6)} USD (${dynamicLeveryFeePercent.toFixed(2)}%)`
      );
      console.log("---");

      resultData.swaps.push({
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
        leveryHookPricePlusFee,
        standardFee,
        dynamicLeveryFee,
      });

      resultData.totalSwaps += 1;
    }

    resultData.totalStandardFee = totalStandardFee;
    resultData.totalDynamicLeveryFee = totalDynamicLeveryFee;

    fs.writeFileSync(outputFileName, JSON.stringify(resultData, null, 2));
    console.log(`Data written to ${outputFileName}`);

    // Log the totals at the end
    console.log(`Total swaps: ${resultData.totalSwaps}`);
    console.log(`Total volume transacted: ${resultData.totalVolumeETH} ETH and ${resultData.totalVolumeUSDC} USDC`);
    console.log(`Total Standard Fee: ${totalStandardFee.toFixed(6)} USD`);
    console.log(`Total Dynamic Levery Fee: ${totalDynamicLeveryFee.toFixed(6)} USD`);
  } catch (error) {
    console.error(error);
  }
}

main().catch(console.error);
