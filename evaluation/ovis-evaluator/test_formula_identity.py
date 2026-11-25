import unittest

from formula_identity import formula_gold_identities


class FormulaIdentityTests(unittest.TestCase):
    def test_upstream_index_space_switch_preserves_exact_gold_identity(self):
        row = {"img_id": "page.jpg", "gt_idx": [28], "gt_position": [29],
               "gt_category_type": "equation_isolated", "gt": "$$x=1$$"}
        expected = formula_gold_identities([row])
        self.assertEqual(expected, formula_gold_identities([{**row, "gt_idx": [6]}]))
        for change in ({"gt": "$$x=2$$"}, {"gt_position": [30]}, {"img_id": "another.jpg"}):
            self.assertNotEqual(expected, formula_gold_identities([{**row, **change}]))
        self.assertNotEqual(expected, formula_gold_identities([row, row]))
        self.assertNotEqual(expected, formula_gold_identities([]))

    def test_formula_groups_and_missing_gold_are_rejected(self):
        row = {"img_id": "page.jpg", "gt_idx": [0], "gt_position": [1],
               "gt_category_type": "equation_isolated", "gt": "$$x$$"}
        for change in ({"gt_idx": [0, 1]}, {"gt_position": []}, {"gt": ""}, {"gt_category_type": "text"}):
            with self.assertRaises(ValueError):
                formula_gold_identities([{**row, **change}])


if __name__ == "__main__":
    unittest.main()
