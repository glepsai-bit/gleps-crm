-- Fix security warning for the new function
ALTER FUNCTION get_monthly_extraction_usage(UUID) SET search_path = public;