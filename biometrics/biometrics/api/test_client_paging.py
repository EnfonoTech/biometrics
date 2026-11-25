# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""Paging against a server whose pages overlap, as BioTime's transaction API does.
Pure unit test: the HTTP call is replaced, no site or server is needed."""

import unittest

from biometrics.biometrics.api.client import BiometricsClient


def _client(server):
	client = BiometricsClient.__new__(BiometricsClient)  # skip __init__: no settings needed
	client._get = server
	return client


def _overlapping_server(total, overlap):
	"""Pages of page_size rows; every page after the first repeats `overlap` rows of the
	previous page, so the last `overlap * (pages - 1)` rows are only returned in one big page."""
	rows = [{"id": i} for i in range(1, total + 1)]
	calls = []

	def get(path, params):
		calls.append(dict(params))
		size, page = params["page_size"], params["page"]
		if size >= total:
			data = rows if page == 1 else []
		else:
			# the page still holds the right number of rows, but shifted back by `overlap`
			length = max(min(size, total - (page - 1) * size), 0)
			start = (page - 1) * size - (overlap if page > 1 else 0)
			data = rows[start : start + length]
		has_next = page * size < total
		return {"count": total, "next": "more" if has_next else None, "data": data}

	return get, calls


class TestOverlappingPages(unittest.TestCase):
	def test_refetches_as_one_page_when_pages_overlap(self):
		server, calls = _overlapping_server(total=140, overlap=32)
		rows = _client(server)._get_all_pages("/iclock/api/transactions/", page_size=100)

		self.assertEqual(sorted(r["id"] for r in rows), list(range(1, 141)))
		self.assertEqual(calls[-1]["page_size"], 140)

	def test_no_refetch_when_pages_are_clean(self):
		server, calls = _overlapping_server(total=140, overlap=0)
		rows = _client(server)._get_all_pages("/iclock/api/transactions/", page_size=100)

		self.assertEqual(len(rows), 140)
		self.assertEqual([c["page_size"] for c in calls], [100, 100])

	def test_require_complete_raises_on_short_set(self):
		def short_server(path, params):
			return {"count": 10, "next": None, "data": [{"id": i} for i in range(5)]}

		with self.assertRaises(Exception):
			_client(short_server)._get_all_pages("/x/", page_size=100, require_complete=True)

	def test_transactions_use_large_pages(self):
		server, calls = _overlapping_server(total=140, overlap=32)
		rows = _client(server).get_transactions(start_time="a", end_time="b")

		self.assertEqual(len(rows), 140)
		self.assertEqual(calls[0]["page_size"], 1000)
		self.assertEqual(calls[0]["start_time"], "a")


if __name__ == "__main__":
	unittest.main()
