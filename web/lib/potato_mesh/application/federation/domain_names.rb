# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# frozen_string_literal: true

require "public_suffix"

module PotatoMesh
  module App
    module Federation
      # The Punycode transfer encoding of RFC 3492, for the labels of an
      # internationalized domain name (SPEC FB3): Ruby's standard library has
      # no IDNA, and the public suffix list names IDN suffixes in Unicode.
      module Punycode
        # Radix of the generalized variable-length integers.
        BASE = 36
        # Least digit threshold.
        TMIN = 1
        # Greatest digit threshold.
        TMAX = 26
        # Bias adaptation skew.
        SKEW = 38
        # Damping of the first bias adaptation.
        DAMP = 700
        # Bias before the first code point.
        INITIAL_BIAS = 72
        # First code point that is not basic (ASCII).
        INITIAL_N = 128
        # Greatest Unicode code point.
        MAX_CODE_POINT = 0x10FFFF
        # UTF-16 surrogates: code points no UTF-8 text may hold.
        SURROGATES = (0xD800..0xDFFF)

        module_function

        # Encode one label (RFC 3492 section 6.3).
        #
        # @param label [String] the label, in Unicode.
        # @return [String] its Punycode form, without the +xn--+ prefix.
        def encode(label)
          points = label.codepoints
          output = +points.select { |point| point < INITIAL_N }.pack("U*")
          handled = basic = output.length
          output << "-" if basic.positive?
          code = INITIAL_N
          delta = 0
          bias = INITIAL_BIAS
          while handled < points.length
            smallest = points.select { |point| point >= code }.min
            delta += (smallest - code) * (handled + 1)
            code = smallest
            points.each do |point|
              delta += 1 if point < code
              next unless point == code

              output << encode_integer(delta, bias)
              bias = adapt(delta, handled + 1, handled == basic)
              delta = 0
              handled += 1
            end
            delta += 1
            code += 1
          end
          output
        end

        # Decode one label (RFC 3492 section 6.2), into valid UTF-8 only.
        #
        # @param text [String] the label's Punycode form, without +xn--+.
        # @return [String] the label in Unicode.
        # @raise [ArgumentError] when +text+ is no valid Punycode or names a
        #   code point UTF-8 cannot hold.
        def decode(text)
          delimiter = text.rindex("-")
          output = delimiter ? text[0...delimiter].codepoints : []
          raise ArgumentError, "non-basic code point" unless output.all? { |point| point < INITIAL_N }

          code = INITIAL_N
          index = 0
          bias = INITIAL_BIAS
          position = delimiter ? delimiter + 1 : 0
          while position < text.length
            before = index
            index, position = decode_integer(text, position, index, bias)
            bias = adapt(index - before, output.length + 1, before.zero?)
            code += index / (output.length + 1)
            index %= output.length + 1
            raise ArgumentError, "code point out of range" if code > MAX_CODE_POINT
            raise ArgumentError, "surrogate code point" if SURROGATES.cover?(code)

            output.insert(index, code)
            index += 1
          end
          output.pack("U*")
        end

        # One variable-length integer, as digits.
        #
        # @param value [Integer] the integer.
        # @param bias [Integer] the current bias.
        # @return [String] its digits.
        def encode_integer(value, bias)
          digits = +""
          step = BASE
          loop do
            limit = threshold(step, bias)
            break if value < limit

            digits << digit_char(limit + ((value - limit) % (BASE - limit)))
            value = (value - limit) / (BASE - limit)
            step += BASE
          end
          digits << digit_char(value)
        end

        # Read one variable-length integer from +text+ at +position+, adding
        # it to +index+.
        #
        # @param text [String] the Punycode text.
        # @param position [Integer] where the integer starts.
        # @param index [Integer] the index it is added to.
        # @param bias [Integer] the current bias.
        # @return [Array(Integer, Integer)] the new index and the position
        #   after the integer.
        # @raise [ArgumentError] on a truncated text or a bad digit.
        def decode_integer(text, position, index, bias)
          weight = 1
          step = BASE
          loop do
            raise ArgumentError, "truncated punycode" if position >= text.length

            digit = char_digit(text[position].ord)
            position += 1
            raise ArgumentError, "invalid punycode digit" if digit >= BASE

            index += digit * weight
            limit = threshold(step, bias)
            return [index, position] if digit < limit

            weight *= BASE - limit
            step += BASE
          end
        end

        # The bias adaptation function (RFC 3492 section 6.1).
        #
        # @param delta [Integer] the last delta.
        # @param points [Integer] code points handled so far.
        # @param first [Boolean] whether this is the first adaptation.
        # @return [Integer] the new bias.
        def adapt(delta, points, first)
          delta = first ? delta / DAMP : delta / 2
          delta += delta / points
          offset = 0
          while delta > ((BASE - TMIN) * TMAX) / 2
            delta /= BASE - TMIN
            offset += BASE
          end
          offset + (((BASE - TMIN + 1) * delta) / (delta + SKEW))
        end

        # The digit threshold at +step+ under +bias+.
        #
        # @param step [Integer] a multiple of {BASE}.
        # @param bias [Integer] the current bias.
        # @return [Integer] a threshold from {TMIN} to {TMAX}.
        def threshold(step, bias)
          (step - bias).clamp(TMIN, TMAX)
        end

        # @param digit [Integer] a digit from 0 to 35.
        # @return [String] its character, +a+ to +z+ then +0+ to +9+.
        def digit_char(digit)
          (digit < 26 ? digit + 97 : digit + 22).chr
        end

        # @param code [Integer] a character's code point.
        # @return [Integer] its digit, {BASE} when it is none.
        def char_digit(code)
          case code
          when 48..57 then code - 22
          when 65..90 then code - 65
          when 97..122 then code - 97
          else BASE
          end
        end
      end

      # Label separators that IDNA reads as a full stop.
      IDN_LABEL_SEPARATORS = "。．｡"

      # Longest domain text read at all: a hostname is at most 253
      # characters, so longer text is refused before any normalization.
      MAX_DOMAIN_TEXT_LENGTH = 1024

      # Longest hostname (RFC 1035), in characters.
      MAX_HOST_LENGTH = 253

      # Longest label, in characters: a longer one is refused before its
      # Punycode encoding, whose time grows with the square of the label's
      # distinct code points.
      MAX_LABEL_LENGTH = 63

      # The canonical form of a federation domain, the one form admission,
      # grouping and storage read (SPEC FB3): the host in lower case without
      # trailing dots, each label that is not ASCII in Punycode (NFKC and
      # lower case first), and the port kept. A bracketed IPv6 literal keeps
      # its form here, for FB10 to refuse. Text longer than any hostname,
      # and a label longer than 63 characters, do not sanitize.
      #
      # @param value [Object] a domain as received, with an optional port.
      # @return [String, nil] the canonical domain, nil when it does not
      #   sanitize.
      def federation_canonical_domain(value)
        text = string_or_nil(value)
        return nil if text.nil? || text.length > MAX_DOMAIN_TEXT_LENGTH

        match = text.match(/\A(?<host>.*?)(?::(?<port>\d+))?\z/m)
        host = match[:host]
        unless host.start_with?("[")
          host = host.unicode_normalize(:nfkc).tr(IDN_LABEL_SEPARATORS, ".").downcase.sub(/\.+\z/, "")
          labels = host.split(".", -1)
          return nil if host.length > MAX_HOST_LENGTH || labels.any? { |label| label.length > MAX_LABEL_LENGTH }

          host = labels.map { |label| label.ascii_only? ? label : "xn--#{Punycode.encode(label)}" }.join(".")
        end
        sanitize_instance_domain(match[:port] ? "#{host}:#{match[:port]}" : host)
      rescue ArgumentError, EncodingError
        nil
      end

      # The host of a canonical domain: a bracketed IPv6 literal with its
      # brackets, any other host without its port.
      #
      # @param canonical [String] a domain {#federation_canonical_domain}
      #   returned.
      # @return [String] the host.
      def federation_canonical_host(canonical)
        canonical.start_with?("[") ? canonical[/\A\[[^\]]*\]/] : canonical.split(":", 2).first
      end

      # Whether +domain+ names its host by an IP address, IPv4 or bracketed
      # IPv6, in any notation the sanitizer accepts (SPEC FB10).
      #
      # @param domain [String] a canonical domain, optionally with a port.
      # @return [Boolean] true for an IP literal.
      def federation_ip_literal?(domain)
        host = federation_canonical_host(domain)
        host.start_with?("[") || PotatoMesh::Sanitizer.valid_ipv4_literal?(host)
      end

      # The registrable domain of a federation domain: the group that
      # {REGISTRABLE_DOMAIN_ROW_LIMIT} caps and the stored
      # +instances.registrable_domain+ (SPEC FB3).
      #
      # The domain is read in its canonical form, the port dropped, by the
      # public suffix list of the +public_suffix+ gem, its private section
      # included, its Punycode labels decoded for the lookup, as the list
      # names IDN suffixes in Unicode: +a.mesh.example.co.uk:8443+ is
      # +example.co.uk+, +foo.github.io+ is itself and +a.xn--1lqs71d.jp+
      # (+a.東京.jp+) is itself. A suffix the list does not name falls under
      # its default rule, the last label: +x.fed.invalid+ is +fed.invalid+.
      # An IP literal, a host that is a public suffix itself, and a host
      # whose group cannot be computed, a Punycode label that does not
      # decode among them, have none; this never raises (SPEC FB10).
      #
      # @param domain [String] a domain, optionally with a port.
      # @return [String, nil] the registrable domain in its canonical ASCII
      #   form, nil when the domain has none (SPEC FB10).
      def federation_registrable_domain(domain)
        canonical = federation_canonical_domain(domain)
        return nil if canonical.nil? || federation_ip_literal?(canonical)

        labels = federation_canonical_host(canonical).split(".")
        lookup = labels.map { |label| federation_unicode_label(label) }
        return nil if lookup.include?(nil)

        registrable = PublicSuffix.domain(lookup.join("."))
        registrable && labels.last(registrable.count(".") + 1).join(".")
      rescue ArgumentError, EncodingError, PublicSuffix::Error
        nil
      end

      # One label for the public suffix lookup: a Punycode label decoded,
      # any other label as it is.
      #
      # @param label [String] an ASCII label.
      # @return [String, nil] the label for the lookup, nil for a Punycode
      #   label that does not decode to valid UTF-8.
      def federation_unicode_label(label)
        return label unless label.start_with?("xn--")

        Punycode.decode(label.delete_prefix("xn--"))
      rescue ArgumentError
        nil
      end

      # Why federation refuses +domain+, if it does (SPEC FB10): it stores,
      # announces to and crawls only hostnames that have a registrable
      # domain.
      #
      # @param domain [Object] a domain, optionally with a port.
      # @return [String, nil] +"invalid domain"+, +"ip literal domain"+ or
      #   +"no registrable domain"+, nil for a domain federation takes.
      def federation_domain_refusal(domain)
        canonical = federation_canonical_domain(domain)
        return "invalid domain" unless canonical
        return "ip literal domain" if federation_ip_literal?(canonical)

        "no registrable domain" unless federation_registrable_domain(canonical)
      end
    end
  end
end
