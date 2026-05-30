drop view if exists qt1865_turbine_12h_daily;

create view qt1865_turbine_12h_daily as
with params as (
  select 0.01::numeric as turbine_threshold
),

hourly_base as (
  select
    time::date as date,
    time,
    turbine_flow,
    case
      when turbine_flow > (select turbine_threshold from params)
        then 1
      else 0
    end as is_running
  from reservoir_hourly_data
  where time is not null
),

running_hours as (
  select
    date,
    time,
    turbine_flow,
    row_number() over (
      partition by date
      order by time
    ) as rn
  from hourly_base
  where is_running = 1
),

running_groups as (
  select
    date,
    time,
    turbine_flow,
    time - (rn::int * interval '1 hour') as grp
  from running_hours
),

streaks as (
  select
    date,
    min(time) as streak_start,
    max(time) as streak_end,
    count(*) as streak_hours,
    round(avg(turbine_flow)::numeric, 2) as avg_turbine_flow,
    round(min(turbine_flow)::numeric, 2) as min_turbine_flow,
    round(max(turbine_flow)::numeric, 2) as max_turbine_flow
  from running_groups
  group by date, grp
),

daily_summary as (
  select
    h.date,
    count(*) as total_record_hours,
    sum(h.is_running) as total_running_hours,
    round(avg(h.turbine_flow)::numeric, 2) as turbine_flow_avg,
    round(max(h.turbine_flow)::numeric, 2) as turbine_flow_max
  from hourly_base h
  group by h.date
),

best_streak as (
  select distinct on (date)
    date,
    streak_start,
    streak_end,
    streak_hours,
    avg_turbine_flow,
    min_turbine_flow,
    max_turbine_flow
  from streaks
  order by date, streak_hours desc, streak_start asc
)

select
  d.date,
  d.total_record_hours,
  d.total_running_hours,
  coalesce(b.streak_hours, 0) as max_turbine_continuous_hours,
  b.streak_start,
  b.streak_end,
  d.turbine_flow_avg,
  d.turbine_flow_max,
  b.avg_turbine_flow as streak_avg_turbine_flow,
  b.min_turbine_flow as streak_min_turbine_flow,
  b.max_turbine_flow as streak_max_turbine_flow,

  case
    when coalesce(b.streak_hours, 0) >= 12 then true
    else false
  end as is_turbine_12h_compliant,

  case
    when coalesce(b.streak_hours, 0) >= 12
      then 'Đảm bảo chạy máy liên tục tối thiểu 12 giờ'
    when coalesce(d.total_running_hours, 0) = 0
      then 'Không chạy máy trong ngày'
    else 'Không đảm bảo chạy máy liên tục 12 giờ'
  end as turbine_12h_status

from daily_summary d
left join best_streak b
  on d.date = b.date
order by d.date;
