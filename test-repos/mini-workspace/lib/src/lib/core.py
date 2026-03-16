from dataclasses import dataclass, field


@dataclass
class Config:
    name: str
    debug: bool = False
    tags: list[str] = field(default_factory=list)


def process_data(config: Config) -> dict:
    result = {
        "name": config.name,
        "processed": True,
        "tag_count": len(config.tags),
    }
    if config.debug:
        result["debug_info"] = f"Processing config: {config.name}"
    return result
