import Foundation
import Testing

@testable import TrackEvolutionKit

/// The cost form's pure half (NS-40), asserted against
/// `contracts/logic/costs.json` — the output of `public/js/costs.js`.
struct CostsTests {
    /// Read per use rather than stored: a `[String: Any]` isn't `Sendable`.
    private var fixture: [String: Any] {
        let data = try! Data(contentsOf: RepoRoot.path("contracts/logic/costs.json"))
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    @Test func theLineItemsMatchTheWebs() {
        #expect((fixture["COST_FIELDS"] as! [[String]]) == Costs.COST_FIELDS.map { [$0.key, $0.label, $0.placeholder] })
    }

    @Test func dollarsToCentsMatchesIncludingTheBinaryRoundingRow() {
        for pair in fixture["dollarsToCents"] as! [[Any]] {
            let raw = pair[0] as? String
            #expect(Costs.dollarsToCents(raw) == pair[1] as? Int, "dollarsToCents(\(String(describing: raw)))")
        }
        // The port trap, stated outright: 0.285 × 100 is 28.499999999999996.
        #expect(Costs.dollarsToCents("0.285") == 28)
        // `Number` refuses what Swift's parser would take.
        #expect(Costs.dollarsToCents("nan") == nil)
        #expect(Costs.dollarsToCents("inf") == nil)
        #expect(Costs.dollarsToCents("0x10") == nil)
    }

    @Test func centsToDollarsAndFmtSpendMatch() {
        for pair in fixture["centsToDollars"] as! [[Any]] {
            #expect(Costs.centsToDollars(pair[0] as? Int) == pair[1] as? String)
        }
        for pair in fixture["fmtSpend"] as! [[Any]] {
            #expect(Costs.fmtSpend(pair[0] as? Int) == pair[1] as? String)
        }
    }

    @Test func eventCostCentsIsNilNeverZeroWithNothingEntered() {
        #expect(Costs.eventCostCents(nil, nil, nil, nil) == nil)
        #expect(Costs.eventCostCents(0, nil, nil, nil) == 0)
        #expect(Costs.eventCostCents(45_000, 19_000, nil, nil) == 64_000)
    }
}
