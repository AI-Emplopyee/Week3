"""Exporter checks for additive saved GLM improvements; no live export is run."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    'sample_review_export', Path(__file__).resolve().parents[1] / 'scripts/export-sample-review.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class SampleReviewExportTests(unittest.TestCase):
    def test_reviewed_content_keeps_missing_and_different_in_denominator(self):
        rows = [{'contentStatus': status} for status in
                ['exact_match'] * 138 + ['reviewed_equivalent'] * 21 +
                ['reviewed_not_equivalent'] * 51 + ['missing'] * 90]
        metric = exporter.metric(rows)
        self.assertEqual(metric['eligible'], 300)
        self.assertEqual(metric['contentCorrect'], 159)
        self.assertEqual(metric['contentAgreement'], .53)
        self.assertEqual(metric['exactAgreement'], .46)
        self.assertEqual(metric['filledCoverage'], .7)
        self.assertEqual(metric['reviewedNotEquivalent'], 51)
        self.assertEqual(metric['missing'], 90)

    def test_structured_components_do_not_inflate_visible_score(self):
        rows = [{'contentStatus': 'missing', 'tab': 'general_1'},
                {'contentStatus': 'exact_match', 'tab': 'structured_goods_only'}]
        metrics = exporter.metrics(rows)
        self.assertEqual(metrics['visible']['eligible'], 1)
        self.assertEqual(metrics['visible']['contentAgreement'], 0)
        self.assertEqual(metrics['all']['contentAgreement'], .5)

    def test_changed_sealed_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'input.json'
            path.write_text('{"sourceOnly":true}')
            sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
            exporter.seal_input(path, sha256)
            self.assertTrue(exporter.read(path)['sourceOnly'])
            path.write_text('{"sourceOnly":false}')
            with self.assertRaisesRegex(AssertionError, 'Sealed input changed'):
                exporter.read(path)
            exporter.SEALED_HASHES.pop(path)

    def test_improved_variant_ids_cannot_replace_original_ids(self):
        ids = [v['id'] for v in exporter.IMPROVED_VARIANTS]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), {'glm53-flash-improved-auto', 'glm53-flash-improved-reviewed'})
        self.assertFalse(set(ids).intersection({'kimi-k26', 'glm53-flash-low', 'glm53-flash-high'}))


if __name__ == '__main__':
    unittest.main()
