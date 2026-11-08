// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../core/Diamond.sol";
import "../core/DiamondCutFacet.sol";
import "../core/DiamondLoupeFacet.sol";
import "../core/PerpetualMarketFacet.sol";
import "../core/PredictionMarketFacet.sol";
import "../libraries/LibDiamond.sol";
import "../libraries/LibPerpetual.sol";
import "../libraries/LibMarket.sol";

/// @notice Repro: closePosition reverts when the trader's remaining balance
/// plus the close proceeds cannot cover the taker fee charged separately
/// against the wallet, even though the position still has collateral left.
contract PerpCloseFeeReproTest is Test {
    Diamond diamond;
    DiamondCutFacet diamondCutFacet;
    DiamondLoupeFacet diamondLoupeFacet;
    PerpetualMarketFacet perpetualFacet;
    PredictionMarketFacet predictionFacet;

    address owner = address(this);
    address carol = address(0x4);
    address oracle = address(0x3);

    bytes32 marketId;

    function mockOraclePrice(int256 price) internal {
        vm.mockCall(
            oracle,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(
                uint80(1),
                price,
                block.timestamp,
                block.timestamp,
                uint80(1)
            )
        );
        vm.mockCall(
            oracle,
            abi.encodeWithSignature("latestAnswer()"),
            abi.encode(price)
        );
    }

    function setUp() public {
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        perpetualFacet = new PerpetualMarketFacet();
        predictionFacet = new PredictionMarketFacet();

        diamond = new Diamond(address(diamondCutFacet), address(diamondLoupeFacet));

        bytes4[] memory loupeSelectors = new bytes4[](4);
        loupeSelectors[0] = DiamondLoupeFacet.facets.selector;
        loupeSelectors[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        loupeSelectors[2] = DiamondLoupeFacet.facetAddress.selector;
        loupeSelectors[3] = DiamondLoupeFacet.facetAddresses.selector;

        IDiamondCut.FacetCut[] memory loupeCuts = new IDiamondCut.FacetCut[](1);
        loupeCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupeFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: loupeSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(loupeCuts, address(0), "");

        bytes4[] memory perpetualSelectors = new bytes4[](10);
        perpetualSelectors[0] = PerpetualMarketFacet.createPerpetualMarket.selector;
        perpetualSelectors[1] = PerpetualMarketFacet.openPosition.selector;
        perpetualSelectors[2] = PerpetualMarketFacet.closePosition.selector;
        perpetualSelectors[3] = PerpetualMarketFacet.liquidatePosition.selector;
        perpetualSelectors[4] = PerpetualMarketFacet.updateFundingRate.selector;
        perpetualSelectors[5] = PerpetualMarketFacet.getPerpetualMarket.selector;
        perpetualSelectors[6] = PerpetualMarketFacet.getPosition.selector;
        perpetualSelectors[7] = PerpetualMarketFacet.getMarkPrice.selector;
        perpetualSelectors[8] = PerpetualMarketFacet.getFundingRate.selector;
        perpetualSelectors[9] = PerpetualMarketFacet.getLiquidationPrice.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(perpetualFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: perpetualSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        bytes4[] memory predictionSelectors = new bytes4[](2);
        predictionSelectors[0] = PredictionMarketFacet.deposit.selector;
        predictionSelectors[1] = PredictionMarketFacet.getBalance.selector;
        IDiamondCut.FacetCut[] memory predictionCuts = new IDiamondCut.FacetCut[](1);
        predictionCuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(predictionFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: predictionSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(predictionCuts, address(0), "");

        marketId = PerpetualMarketFacet(address(diamond)).createPerpetualMarket(
            "BTC-PERP",
            oracle,
            10, // 10x max leverage
            500, // 5% maintenance margin
            1000, // 10% initial margin
            250, // 2.5% liquidation fee
            10, // 0.1% maker fee
            20 // 0.2% taker fee
        );

        // Carol deposits exactly enough to open: 5000 collateral + 100 open fee.
        vm.deal(carol, 100000 ether);
        vm.prank(carol);
        PredictionMarketFacet(address(diamond)).deposit{value: 5100 ether}();
    }

    function testClosePositionWithLossBelowFee() public {
        // Entry at $50,000, 1 BTC long, 5000 ether collateral.
        mockOraclePrice(50000e8);
        vm.prank(carol);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            1e18,
            5000 ether,
            51000e8
        );

        // Wallet is now empty (5100 - 5000 collateral - 100 open fee).
        assertEq(
            PredictionMarketFacet(address(diamond)).getBalance(carol),
            0
        );

        // Price drops to $45,050: PnL -4950, proceeds 50 ether.
        // Close fee is 0.2% of $45,050 = 90.1 ether > 50 ether proceeds.
        mockOraclePrice(45050e8);

        vm.prank(carol);
        PerpetualMarketFacet(address(diamond)).closePosition(
            marketId,
            40000e8
        );

        // Position is closed and the fee takes the remaining proceeds.
        (LibPerpetual.Side side, uint256 size, , , , , ) =
            PerpetualMarketFacet(address(diamond)).getPosition(carol, marketId);
        assertEq(size, 0);
        assertEq(uint8(side), uint8(LibPerpetual.Side.LONG));
        // 50 ether proceeds, fee capped at 50 ether, trader keeps 0.
        assertEq(
            PredictionMarketFacet(address(diamond)).getBalance(carol),
            0
        );
    }

    function testClosePositionFeeNettedFromProceeds() public {
        // Happy path must be unchanged: fee comes out of the proceeds.
        mockOraclePrice(50000e8);
        vm.prank(carol);
        PerpetualMarketFacet(address(diamond)).openPosition(
            marketId,
            LibPerpetual.Side.LONG,
            1e18,
            5000 ether,
            51000e8
        );

        // Price rises to $55,000: PnL +5000, proceeds 10000 ether.
        mockOraclePrice(55000e8);

        vm.prank(carol);
        PerpetualMarketFacet(address(diamond)).closePosition(
            marketId,
            45000e8
        );

        // Balance 0 after open + 10000 proceeds - 110 fee (0.2% of $55k).
        assertEq(
            PredictionMarketFacet(address(diamond)).getBalance(carol),
            9890 ether
        );
        (LibPerpetual.Side side, uint256 size, , , , , ) =
            PerpetualMarketFacet(address(diamond)).getPosition(carol, marketId);
        assertEq(size, 0);
        assertEq(uint8(side), uint8(LibPerpetual.Side.LONG));
    }
}
