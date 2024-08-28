# Levery Market Simulation

## Overview

This project fetches swap details from the Uniswap v3 subgraph and compares the swap prices with historical prices from the Chainlink Oracle. It calculates standard and dynamic fees for each swap and logs the details. Additionally, the results are saved in a structured JSON file named with the current date.

This project was created within the Uniswap Hooks incubator.

## Features - Uniswap and Chainlink Price Comparison

- Fetches swap details from Uniswap v3 subgraph.
- Fetches historical prices from the Chainlink Oracle.
- Calculates and logs standard and dynamic fees for each swap.
- Calculates and logs the Levery Hook Price for each swap.
- Saves the results in a JSON file named with the current date.
- Provides detailed logs for debugging and analysis.

## Advantages of Levery

Levery brings several advantages to this simulation:

1. **Mitigation of Impermanent Loss and Toxic Arbitrage**: Levery enhances profitability for liquidity providers by leveraging Uniswap V4's hooks to implement dynamic fees based on real-time data from price feed oracles. These oracles supply crucial market price information, allowing for precise adjustments of dynamic fees to maintain fair pricing and mitigate toxic arbitrage risks. This mechanism optimizes returns on investments for liquidity providers and significantly reduces the impact of impermanent loss by ensuring that pool prices reflect current market conditions.
2. **Regulatory Compliance**: Designed with stringent AML and KYC frameworks, Levery enables financial institutions to participate in DeFi without compromising on compliance. This ensures that all operations on the platform meet global regulatory standards, making it a viable and attractive option for institutional investors.
3. **Secure and Transparent Environment**: The use of comprehensive identity checks and permission management systems guarantees a secure trading environment where all participants are verified. This transparency builds trust and facilitates smoother transactions, attracting more institutional participants to the platform.

## Prerequisites

- Node.js
- NPM or Yarn
- Alchemy or Infura account for Ethereum JSON-RPC provider

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/levery-org/levery-market-simulation.git
   cd levery-market-simulation
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

   or

   ```bash
   npm install
   ```

3. Set up your environment:

   - Create a file named `AggregatorV3Interface.json` and add the ABI for the Chainlink AggregatorV3Interface.
   - Replace the `YOUR_ALCHEMY_OR_INFURA_KEY` in the script with your Alchemy or Infura key.

## Usage

Rename named `.env.example` to `.env` in the root of your project and add your Ethereum Mainnet RPC url:

```bash
RPC_URL=ethereum_mainnet_rpc_url_here
```

Run the simulation:

```bash
yarn start
```

or

```bash
npm start
```
