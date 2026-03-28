from datetime import UTC, datetime

from sqlmodel import Field, Session, SQLModel, create_engine, delete

# Database path
database_url = "storage/chest_counter.db"

# Create engine instance
engine = create_engine(f"sqlite:///{database_url}")


# Model in database
class Chest(SQLModel, table=True):
    id: int = Field(default=None, primary_key=True)
    indatetime: datetime = Field(default_factory=lambda: datetime.now(UTC).replace(tzinfo=None))
    clan: str = ""
    chest_name: str
    chest_name_sureness: int
    chest_source: str
    player_name: str
    player_name_sureness: int
    level: int
    points: int
    raw_body: str = Field(default=None)  # Raw text for future error tracking

    def to_dict(self):
        """Return model data as dictionary."""
        return {
            "id": self.id,
            "clan": self.clan,
            "chest_name": self.chest_name,
            "chest_source": self.chest_source,
            "chest_name_sureness": self.chest_name_sureness,
            "player_name": self.player_name,
            "player_name_sureness": self.player_name_sureness,
            "level": self.level,
            "points": self.points,
            "raw_body": self.raw_body,
        }


def initialize_database():
    SQLModel.metadata.create_all(engine)


def get_session():
    return Session(engine)


def clear_all_chests():
    with Session(engine) as session:
        session.exec(delete(Chest))
        session.commit()


if __name__ == "__main__":
    initialize_database()
    print(f"Database file initialized in {database_url}")
