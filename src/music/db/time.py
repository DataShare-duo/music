"""Beijing wall-clock storage, with per-field flags preserving legacy UTC values."""

from datetime import UTC, datetime, timedelta, timezone

from sqlalchemy import DateTime, Integer, case, event, inspect, literal, type_coerce
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Mapped, Session, mapped_column
from sqlalchemy.sql.functions import FunctionElement
from sqlalchemy.types import TypeDecorator

BEIJING = timezone(timedelta(hours=8), "Asia/Shanghai")
# Stable, append-only bit assignments; never reorder or recycle these bits.
TIME_BITS = {
    "created_at": 1,
    "updated_at": 2,
    "checked_at": 4,
    "next_check_at": 8,
    "first_clicked_at": 16,
    "last_clicked_at": 32,
    "first_listened_at": 64,
    "last_listened_at": 128,
    "resolved_at": 256,
    "expires_at": 512,
    "audio_expires_at": 1024,
    "avatar_updated_at": 2048,
    "happened_at": 4096,
}
BEIJING_MASK = sum(TIME_BITS.values())


def now() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator):
    """Internal normalized instant; API serialization remains timezone-aware UTC."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("时间必须包含时区，不能依赖运行主机的本地时区")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        return value.replace(tzinfo=UTC) if value is not None else None


class _MinusEightHours(FunctionElement):
    type = DateTime()
    inherit_cache = True


@compiles(_MinusEightHours, "mysql")
def _mysql_utc(element, compiler, **kwargs):
    column = compiler.process(list(element.clauses)[0], **kwargs)
    return f"TIMESTAMPADD(HOUR, -8, {column})"


@compiles(_MinusEightHours, "sqlite")
def _sqlite_utc(element, compiler, **kwargs):
    column = compiler.process(list(element.clauses)[0], **kwargs)
    # SQLite is test-only; retain the original fractional seconds exactly.
    return f"(datetime({column}, '-8 hours') || substr({column}, 20))"


def utc_expression(column):
    base = column
    while getattr(base, "table", None) is None and hasattr(base, "element"):
        base = base.element
    table = getattr(base, "table", None)
    name = getattr(base, "name", None)
    if table is None or name not in TIME_BITS or "time_storage_mask" not in table.c:
        raise ValueError("时间表达式缺少来源字段或存储时区标记")
    beijing = table.c.time_storage_mask.op("&")(TIME_BITS[name]) != 0
    return type_coerce(case((beijing, _MinusEightHours(base)), else_=base), UTCDateTime())


class BeijingDateTime(UTCDateTime):
    """Write +08:00; read/query UTC instants without changing legacy UTC cells."""

    cache_ok = True

    def process_bind_param(self, value, dialect):
        utc = super().process_bind_param(value, dialect)
        return utc + timedelta(hours=8) if utc is not None else None

    def column_expression(self, column):
        return utc_expression(column)

    class comparator_factory(TypeDecorator.Comparator):
        def operate(self, op, *other, **kwargs):
            return op(utc_expression(self.expr), *other, **kwargs)

        def reverse_operate(self, op, other, **kwargs):
            return op(other, utc_expression(self.expr), **kwargs)


class BeijingTimeMixin:
    time_storage_mask: Mapped[int] = mapped_column(
        Integer, default=BEIJING_MASK, server_default=str(BEIJING_MASK)
    )


@event.listens_for(Session, "before_flush")
def _mark_written_times(session, flush_context, instances):
    for entity in session.new:
        if isinstance(entity, BeijingTimeMixin):
            entity.time_storage_mask = BEIJING_MASK
    for entity in session.dirty:
        if not isinstance(entity, BeijingTimeMixin):
            continue
        state = inspect(entity)
        mask = entity.time_storage_mask
        for column in state.mapper.columns:
            if (
                isinstance(column.type, BeijingDateTime)
                and state.attrs[column.key].history.has_changes()
            ):
                mask |= TIME_BITS[column.name]
        entity.time_storage_mask = mask


def mark_times(model, *names, first_if_null=()):
    """Core UPDATEs must assign this marker before conditional timestamp fields."""
    mask = model.time_storage_mask.op("|")(sum(TIME_BITS[name] for name in names))
    for name in first_if_null:
        mask = mask.op("|")(case((getattr(model, name).is_(None), TIME_BITS[name]), else_=0))
    return mask


def first_time(column, value):
    """Preserve an existing raw cell; explicitly bind a new first-time as +08:00."""
    return case((column.is_(None), literal(value, type_=BeijingDateTime())), else_=column)
