"""Build the playable catalog from the four supplied 25-event CSV files."""
import csv
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "videos" / "ntn_4.0_100_videos (1)"
SETS = ["track_smallspan_25", "track_clumped_25", "cascade_clumped_25", "cascade_largespan_25"]


def build_manifest():
    videos = []
    for index, folder in enumerate(SETS, 1):
        with (CATALOG / f"{folder}_events.csv").open(newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        if len(rows) != 25:
            raise ValueError(f"Expected 25 events in {folder}, found {len(rows)}")
        listed_files = set()
        for row in rows:
            # Supplied CSVs omit the underscore after 'directory'; actual MP4s include it.
            filename = re.sub(r"directory_?(\d+)", r"directory_\1", row["Video"].strip())
            if Path(filename).name != filename or not (CATALOG / folder / filename).is_file():
                raise ValueError(f"Missing video: {folder}/{filename}")
            choice = {"1": "track", "2": "cascade"}.get(row["InteractionType"])
            if choice is None or choice != row["Event_type"].strip().lower():
                raise ValueError(f"Conflicting answer key for {filename}")
            if filename in listed_files:
                raise ValueError(f"Duplicate video in {folder}: {filename}")
            listed_files.add(filename)
            videos.append({"video": f"{folder}/{filename}", "Run_Number": row["Run"],
                           "EventID": row["Event_ID"], "InteractionType": row["InteractionType"],
                           "VideoSet": f"Set {index}"})
        actual_files = {p.name for p in (CATALOG / folder).glob("*.mp4")}
        if actual_files != listed_files:
            raise ValueError(f"Unlisted videos in {folder}: {actual_files - listed_files}")
    manifest = CATALOG / "manifest.csv"
    with manifest.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["video", "Run_Number", "EventID", "InteractionType", "VideoSet"])
        writer.writeheader()
        writer.writerows(videos)
    print(f"Built {manifest.relative_to(ROOT)}: {len(videos)} clips across {len(SETS)} sets.")


if __name__ == "__main__":
    build_manifest()
